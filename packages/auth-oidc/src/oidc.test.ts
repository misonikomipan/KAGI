import { beforeAll, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { jwtBearerAuthenticator } from "./bearer.ts";
import { oidcAuthenticator } from "./oidc.ts";

const ISSUER = "https://id.example.com";
const ORIGIN = "https://door.example.com";
const SECRET = "x".repeat(32);

/** A minimal in-memory OIDC provider: discovery, authorize (via the test), token, userinfo, JWKS. */
async function fakeProvider() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { nonce: string; challenge: string }>();

  const sign = (claims: Record<string, unknown>) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setIssuedAt().setExpirationTime("5m").sign(privateKey);

  const providerFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          userinfo_endpoint: `${ISSUER}/userinfo`,
          jwks_uri: `${ISSUER}/jwks`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        });
      case "/jwks":
        return Response.json({ keys: [jwk] });
      case "/token": {
        const form = new URLSearchParams(await req.text());
        const entry = codes.get(form.get("code") ?? "");
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") ?? ""));
        const challenge = Buffer.from(digest).toString("base64url");
        if (!entry || entry.challenge !== challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
        const id_token = await sign({ sub: "u_alice", aud: "kagi", nonce: entry.nonce, name: "Alice" });
        return Response.json({ access_token: "at", token_type: "Bearer", id_token });
      }
      case "/userinfo":
        return Response.json({ sub: "u_alice", groups: ["staff", "door:home"] });
      default:
        return new Response("not found", { status: 404 });
    }
  }) as typeof fetch;

  /** What the browser does at the provider: approve and come back with a code. */
  const approve = (authorizeUrl: string) => {
    const u = new URL(authorizeUrl);
    const code = crypto.randomUUID();
    codes.set(code, { nonce: u.searchParams.get("nonce") ?? "", challenge: u.searchParams.get("code_challenge") ?? "" });
    return `${u.searchParams.get("redirect_uri")}?code=${code}&state=${u.searchParams.get("state")}&iss=${encodeURIComponent(ISSUER)}`;
  };

  return { fetch: providerFetch, approve, sign };
}

/** Collects Set-Cookie headers like a browser would (name=value only). */
function cookieJar() {
  const jar = new Map<string, string>();
  return {
    store(res: Response) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const i = pair?.indexOf("=") ?? -1;
        if (!pair || i < 0) continue;
        const v = pair.slice(i + 1);
        if (v === "") jar.delete(pair.slice(0, i));
        else jar.set(pair.slice(0, i), v);
      }
    },
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
  };
}

let idp: Awaited<ReturnType<typeof fakeProvider>>;
beforeAll(async () => {
  idp = await fakeProvider();
});

describe("oidcAuthenticator", () => {
  const make = () => oidcAuthenticator({ issuer: ISSUER, clientId: "kagi", publicOrigin: ORIGIN, sessionSecret: SECRET, scopes: "openid profile groups", fetch: idp.fetch });

  test("full sign-in round trip ends with a session carrying the groups", async () => {
    const auth = make();
    const jar = cookieJar();
    const door = `${ORIGIN}/d/home`;

    // 1. Not signed in: redirected to the provider with PKCE + state + nonce.
    const first = await auth.authenticate(new Request(door), { returnTo: door });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    const authorizeUrl = first.response.headers.get("location") ?? "";
    expect(authorizeUrl.startsWith(`${ISSUER}/authorize`)).toBe(true);
    expect(new URL(authorizeUrl).searchParams.get("code_challenge_method")).toBe("S256");
    expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    jar.store(first.response);

    // 2. Provider approves; callback sets the session and returns to the door.
    const cb = await auth.handle?.(new Request(idp.approve(authorizeUrl), { headers: { cookie: jar.header() } }));
    expect(cb?.status).toBe(303);
    expect(cb?.headers.get("location")).toBe(door);
    if (cb) jar.store(cb);

    // 3. Signed in.
    const again = await auth.authenticate(new Request(door, { headers: { cookie: jar.header() } }), { returnTo: door });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.principal).toMatchObject({ id: "u_alice", displayName: "Alice", claims: { groups: ["staff", "door:home"] } });
    expect(again.principal.claims.nonce).toBeUndefined();
  });

  test("callback with a forged state is rejected", async () => {
    const auth = make();
    const jar = cookieJar();
    const first = await auth.authenticate(new Request(`${ORIGIN}/d/home`), { returnTo: `${ORIGIN}/d/home` });
    if (first.ok) throw new Error("unexpected");
    jar.store(first.response);
    const url = new URL(idp.approve(first.response.headers.get("location") ?? ""));
    url.searchParams.set("state", "forged");
    const cb = await auth.handle?.(new Request(url, { headers: { cookie: jar.header() } }));
    expect(cb?.status).toBe(403);
  });

  test("callback without the login cookie is rejected", async () => {
    const cb = await make().handle?.(new Request(`${ORIGIN}/auth/callback?code=x&state=y`));
    expect(cb?.status).toBe(400);
  });

  test("returnTo on another origin falls back to /", async () => {
    const auth = make();
    const jar = cookieJar();
    const first = await auth.authenticate(new Request(`${ORIGIN}/d/home`), { returnTo: "https://evil.example/" });
    if (first.ok) throw new Error("unexpected");
    jar.store(first.response);
    const cb = await auth.handle?.(new Request(idp.approve(first.response.headers.get("location") ?? ""), { headers: { cookie: jar.header() } }));
    expect(cb?.headers.get("location")).toBe(`${ORIGIN}/`);
  });

  test("tampered session cookie is ignored", async () => {
    const res = await make().authenticate(new Request(`${ORIGIN}/d/home`, { headers: { cookie: "__Host-kagi_session=garbage" } }), {
      returnTo: `${ORIGIN}/d/home`,
    });
    expect(res.ok).toBe(false);
  });

  test("rejects a short session secret", () => {
    expect(() => oidcAuthenticator({ issuer: ISSUER, clientId: "kagi", publicOrigin: ORIGIN, sessionSecret: "short" })).toThrow();
  });
});

describe("jwtBearerAuthenticator", () => {
  const make = (extra: { authorizedParties?: string[] } = {}) => jwtBearerAuthenticator({ issuer: ISSUER, fetch: idp.fetch, ...extra });
  const call = (token?: string) =>
    new Request(`${ORIGIN}/api/doors/home/unlock`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });

  test("accepts a token signed by the issuer", async () => {
    const token = await idp.sign({ sub: "u_bob", email: "bob@example.com", azp: "https://hcm.example.com" });
    const r = await make({ authorizedParties: ["https://hcm.example.com"] }).authenticate(call(token), { returnTo: "" });
    expect(r.ok && r.principal).toMatchObject({ id: "u_bob", displayName: "bob@example.com" });
  });

  test("rejects missing, foreign and wrong-azp tokens with 401", async () => {
    expect((await make().authenticate(call(), { returnTo: "" })).ok).toBe(false);

    const { privateKey } = await generateKeyPair("RS256");
    const foreign = await new SignJWT({ sub: "x" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setExpirationTime("5m").sign(privateKey);
    const r = await make().authenticate(call(foreign), { returnTo: "" });
    expect(!r.ok && r.response.status).toBe(401);

    const wrongAzp = await idp.sign({ sub: "u_bob", azp: "https://evil.example" });
    expect((await make({ authorizedParties: ["https://hcm.example.com"] }).authenticate(call(wrongAzp), { returnTo: "" })).ok).toBe(false);
  });
});
