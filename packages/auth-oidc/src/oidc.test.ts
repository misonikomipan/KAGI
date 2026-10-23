import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { EncryptJWT, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
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
  /** Lets a test make the provider misbehave. Reset in beforeEach. */
  const tamper: { nonce?: string; aud?: string; userinfo?: Record<string, unknown> } = {};

  /** Expires in 5 minutes unless `claims` has its own `exp` (set it to undefined for none). */
  const sign = (claims: Record<string, unknown>) => {
    const jwt = new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setIssuedAt();
    if (!("exp" in claims)) jwt.setExpirationTime("5m");
    return jwt.sign(privateKey);
  };

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
        const id_token = await sign({ sub: "u_alice", aud: tamper.aud ?? "kagi", nonce: tamper.nonce ?? entry.nonce, name: "Alice" });
        return Response.json({ access_token: "at", token_type: "Bearer", id_token });
      }
      case "/userinfo":
        return Response.json({ sub: "u_alice", groups: ["staff", "door:home"], picture: "https://id.example.com/a.png", ...tamper.userinfo });
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

  return { fetch: providerFetch, approve, sign, tamper };
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
beforeEach(() => {
  for (const k of Object.keys(idp.tamper)) delete idp.tamper[k as keyof typeof idp.tamper];
});

/** Runs the whole sign-in for `door` and returns the callback response and the browser's cookies. */
async function signIn(auth: ReturnType<typeof oidcAuthenticator>, returnTo = `${ORIGIN}/d/home`) {
  const jar = cookieJar();
  const first = await auth.authenticate(new Request(`${ORIGIN}/d/home`), { returnTo });
  if (first.ok) throw new Error("expected a redirect to the provider");
  jar.store(first.response);
  const cb = await auth.handle?.(new Request(idp.approve(first.response.headers.get("location") ?? ""), { headers: { cookie: jar.header() } }));
  if (!cb) throw new Error("callback not handled");
  jar.store(cb);
  return { cb, jar };
}

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
    const real = url.searchParams.get("state") ?? "";

    // Unknown state: no login cookie belongs to it.
    url.searchParams.set("state", "forged");
    const a = await auth.handle?.(new Request(url, { headers: { cookie: jar.header() } }));
    expect(a?.status).toBe(400);

    // Same cookie (first 16 chars match) but a different state: openid-client's check rejects it.
    url.searchParams.set("state", `${real.slice(0, 16)}forged`);
    const b = await auth.handle?.(new Request(url, { headers: { cookie: jar.header() } }));
    expect(b?.status).toBe(403);
    for (const r of [a, b]) expect(r?.headers.getSetCookie().some((c) => c.includes("kagi_session="))).toBe(false);
  });

  test("callback without the login cookie is rejected", async () => {
    const cb = await make().handle?.(new Request(`${ORIGIN}/auth/callback?code=x&state=y`));
    expect(cb?.status).toBe(400);
  });

  test("returnTo on another origin is not followed; the callback just says signed in", async () => {
    const { cb } = await signIn(make(), "https://evil.example/");
    expect(cb.status).toBe(200);
    expect(cb.headers.get("location")).toBeNull();
    expect(cb.headers.getSetCookie().some((c) => c.startsWith("__Host-kagi_session="))).toBe(true);
  });

  test("tampered session cookie is ignored", async () => {
    const res = await make().authenticate(new Request(`${ORIGIN}/d/home`, { headers: { cookie: "__Host-kagi_session=garbage" } }), {
      returnTo: `${ORIGIN}/d/home`,
    });
    expect(res.ok).toBe(false);
  });

  test("two sign-ins in parallel (double tap) both complete", async () => {
    const auth = make();
    const jar = cookieJar();
    const a = await auth.authenticate(new Request(`${ORIGIN}/d/home`), { returnTo: `${ORIGIN}/d/home` });
    const b = await auth.authenticate(new Request(`${ORIGIN}/d/home`), { returnTo: `${ORIGIN}/d/home` });
    if (a.ok || b.ok) throw new Error("unexpected");
    jar.store(a.response);
    jar.store(b.response);
    for (const r of [a, b]) {
      const cb = await auth.handle?.(new Request(idp.approve(r.response.headers.get("location") ?? ""), { headers: { cookie: jar.header() } }));
      expect(cb?.status).toBe(303);
    }
  });

  test("an ID token with the wrong nonce is rejected", async () => {
    idp.tamper.nonce = "someone-elses-nonce";
    expect((await signIn(make())).cb.status).toBe(403);
  });

  test("an ID token for another client (aud) is rejected", async () => {
    idp.tamper.aud = "other-app";
    expect((await signIn(make())).cb.status).toBe(403);
  });

  test("keepClaims limits what the session stores", async () => {
    const auth = oidcAuthenticator({ issuer: ISSUER, clientId: "kagi", publicOrigin: ORIGIN, sessionSecret: SECRET, fetch: idp.fetch, keepClaims: ["groups"] });
    const { jar } = await signIn(auth);
    const r = await auth.authenticate(new Request(`${ORIGIN}/d/home`, { headers: { cookie: jar.header() } }), { returnTo: `${ORIGIN}/d/home` });
    expect(r.ok && r.principal.claims).toEqual({ groups: ["staff", "door:home"] });
  });

  test("a session too large for a cookie fails visibly instead of looping", async () => {
    idp.tamper.userinfo = { groups: Array.from({ length: 200 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`) };
    const { cb } = await signIn(make());
    expect(cb.status).toBe(500);
    expect(cb.headers.getSetCookie().some((c) => c.startsWith("__Host-kagi_session="))).toBe(false);
  });

  test("an expired session is not accepted", async () => {
    const key = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SECRET)));
    const expired = await new EncryptJWT({ sub: "u_alice", name: "Alice", claims: {}, pur: "session" })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuedAt(1_000)
      .setExpirationTime(2_000)
      .encrypt(key);
    const r = await make().authenticate(new Request(`${ORIGIN}/d/home`, { headers: { cookie: `__Host-kagi_session=${expired}` } }), { returnTo: `${ORIGIN}/d/home` });
    expect(r.ok).toBe(false);
  });

  test("a login cookie replayed as the session cookie is not accepted", async () => {
    const auth = make();
    const first = await auth.authenticate(new Request(`${ORIGIN}/d/home`), { returnTo: `${ORIGIN}/d/home` });
    if (first.ok) throw new Error("unexpected");
    const login = first.response.headers.getSetCookie()[0]?.split(";")[0]?.split("=").slice(1).join("=") ?? "";
    const r = await auth.authenticate(new Request(`${ORIGIN}/d/home`, { headers: { cookie: `__Host-kagi_session=${login}` } }), { returnTo: `${ORIGIN}/d/home` });
    expect(r.ok).toBe(false);
  });

  test("logout is POST only and clears the session", async () => {
    const auth = make();
    expect(await auth.handle?.(new Request(`${ORIGIN}/auth/logout`))).toBeNull();
    const res = await auth.handle?.(new Request(`${ORIGIN}/auth/logout`, { method: "POST" }));
    expect(res?.status).toBe(200);
    expect(res?.headers.getSetCookie()[0]).toContain("Max-Age=0");
  });

  test("the provider being down is an error (the server turns it into a 503 page)", async () => {
    const down = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const auth = oidcAuthenticator({ issuer: ISSUER, clientId: "kagi", publicOrigin: ORIGIN, sessionSecret: SECRET, fetch: down });
    await expect(auth.authenticate(new Request(`${ORIGIN}/d/home`), { returnTo: `${ORIGIN}/d/home` })).rejects.toThrow();
  });

  test("rejects a short session secret", () => {
    expect(() => oidcAuthenticator({ issuer: ISSUER, clientId: "kagi", publicOrigin: ORIGIN, sessionSecret: "short" })).toThrow();
  });

  const loginCookies = (jar: ReturnType<typeof cookieJar>) => jar.header().split("; ").filter((c) => c.startsWith("__Host-kagi_login_"));

  test("abandoned sign-ins do not pile up login cookies", async () => {
    const auth = make();
    const jar = cookieJar();
    for (let i = 0; i < 8; i++) {
      const r = await auth.authenticate(new Request(`${ORIGIN}/d/home`, { headers: { cookie: jar.header() } }), { returnTo: `${ORIGIN}/d/home` });
      if (r.ok) throw new Error("unexpected");
      jar.store(r.response);
      expect(loginCookies(jar).length).toBeLessThanOrEqual(3);
    }
  });

  test("a failed callback (403) clears its login cookie", async () => {
    idp.tamper.nonce = "not-the-nonce";
    const { cb, jar } = await signIn(make());
    expect(cb.status).toBe(403);
    expect(loginCookies(jar)).toEqual([]);
  });

  test("a too-large session (500) clears its login cookie and names a fix the admin can apply", async () => {
    idp.tamper.userinfo = { groups: Array.from({ length: 200 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`) };
    const { cb, jar } = await signIn(make());
    expect(cb.status).toBe(500);
    expect(loginCookies(jar)).toEqual([]);
    expect(await cb.text()).toContain("prefix");
  });

  test("narrowClaim keeps only door groups, so accounts with many groups still fit", async () => {
    idp.tamper.userinfo = { groups: [...Array.from({ length: 200 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`), "door:home"] };
    const auth = oidcAuthenticator({ issuer: ISSUER, clientId: "kagi", publicOrigin: ORIGIN, sessionSecret: SECRET, fetch: idp.fetch, keepClaims: ["groups"], narrowClaim: { path: "groups", prefix: "door:" } });
    const { cb, jar } = await signIn(auth);
    expect(cb.status).toBe(303);
    const r = await auth.authenticate(new Request(`${ORIGIN}/d/home`, { headers: { cookie: jar.header() } }), { returnTo: `${ORIGIN}/d/home` });
    expect(r.ok && r.principal.claims).toEqual({ groups: ["door:home"] });
  });

  test("keepClaims keeps a nested claim by its top-level key; narrowClaim follows the dotted path", async () => {
    idp.tamper.userinfo = { publicMetadata: { doors: ["door:home", "other"], note: "x" } };
    const auth = oidcAuthenticator({ issuer: ISSUER, clientId: "kagi", publicOrigin: ORIGIN, sessionSecret: SECRET, fetch: idp.fetch, keepClaims: ["publicMetadata"], narrowClaim: { path: "publicMetadata.doors", prefix: "door:" } });
    const { jar } = await signIn(auth);
    const r = await auth.authenticate(new Request(`${ORIGIN}/d/home`, { headers: { cookie: jar.header() } }), { returnTo: `${ORIGIN}/d/home` });
    expect(r.ok && r.principal.claims).toEqual({ publicMetadata: { doors: ["door:home"], note: "x" } });
  });

  test("advertises its logout path for the door page", () => {
    expect(make().logoutPath).toBe("/auth/logout");
  });

  test("a session cookie sealed with another JWE algorithm is not accepted, even with the right key", async () => {
    const key = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SECRET)));
    const wrap = await new EncryptJWT({ sub: "u_alice", name: "Alice", claims: {}, pur: "session" })
      .setProtectedHeader({ alg: "A256KW", enc: "A256GCM" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .encrypt(key);
    const r = await make().authenticate(new Request(`${ORIGIN}/d/home`, { headers: { cookie: `__Host-kagi_session=${wrap}` } }), { returnTo: `${ORIGIN}/d/home` });
    expect(r.ok).toBe(false);
  });
});

describe("jwtBearerAuthenticator", () => {
  const HCM = "https://hcm.example.com";
  const make = (extra: { authorizedParties?: string[]; audience?: string } = { authorizedParties: [HCM] }) => jwtBearerAuthenticator({ issuer: ISSUER, fetch: idp.fetch, ...extra });
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

  test("refuses to be configured without audience or authorizedParties", () => {
    expect(() => jwtBearerAuthenticator({ issuer: ISSUER })).toThrow(/audience|authorizedParties/);
  });

  test("rejects a token for another audience", async () => {
    const token = await idp.sign({ sub: "u_bob", aud: "other-api" });
    expect((await make({ audience: "kagi-api" }).authenticate(call(token), { returnTo: "" })).ok).toBe(false);
    const ok = await idp.sign({ sub: "u_bob", aud: "kagi-api" });
    expect((await make({ audience: "kagi-api" }).authenticate(call(ok), { returnTo: "" })).ok).toBe(true);
  });

  test("rejects expired tokens and tokens without exp", async () => {
    const expired = await idp.sign({ sub: "u_bob", azp: HCM, exp: Math.floor(Date.now() / 1000) - 60 });
    expect((await make().authenticate(call(expired), { returnTo: "" })).ok).toBe(false);
    const forever = await idp.sign({ sub: "u_bob", azp: HCM, exp: undefined });
    expect((await make().authenticate(call(forever), { returnTo: "" })).ok).toBe(false);
  });

  test("an unreachable issuer is 503 (retry later), not 401 (bad token)", async () => {
    const token = await idp.sign({ sub: "u_bob", azp: HCM });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const r1 = await jwtBearerAuthenticator({ issuer: ISSUER, authorizedParties: [HCM], fetch: down }).authenticate(call(token), { returnTo: "" });
    expect(!r1.ok && r1.response.status).toBe(503);

    const jwksBroken = (async (input: RequestInfo | URL, init?: RequestInit) =>
      new URL(new Request(input, init).url).pathname === "/jwks" ? new Response("oops", { status: 500 }) : idp.fetch(input, init)) as typeof fetch;
    const r2 = await jwtBearerAuthenticator({ issuer: ISSUER, authorizedParties: [HCM], fetch: jwksBroken }).authenticate(call(token), { returnTo: "" });
    expect(!r2.ok && r2.response.status).toBe(503);

    // A bad token with a reachable issuer is still 401.
    const r3 = await make().authenticate(call("not.a.jwt"), { returnTo: "" });
    expect(!r3.ok && r3.response.status).toBe(401);
  });

  test("rejects HS256 and unsigned tokens", async () => {
    const hs = await new SignJWT({ sub: "u_bob", azp: HCM }).setProtectedHeader({ alg: "HS256" }).setIssuer(ISSUER).setExpirationTime("5m").sign(new TextEncoder().encode("x".repeat(32)));
    expect((await make().authenticate(call(hs), { returnTo: "" })).ok).toBe(false);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const none = `${b64({ alg: "none" })}.${b64({ sub: "u_bob", azp: HCM, iss: ISSUER, exp: Math.floor(Date.now() / 1000) + 300 })}.`;
    expect((await make().authenticate(call(none), { returnTo: "" })).ok).toBe(false);
  });
});
