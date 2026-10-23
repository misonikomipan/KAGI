import { expect, test } from "bun:test";
import { oidcAuthenticator } from "@kagi/auth-oidc";
import { type Authenticator, createGate, type Gate, type LockDriver, type Principal, type UnlockOutcome } from "@kagi/core";
import { createKagiApp, en } from "./index.tsx";

const ORIGIN = "https://door.example.com";
const alice: Principal = { id: "u_alice", displayName: "Alice", claims: { publicMetadata: { doors: ["office"] } } };

function setupGate(opts: { allow?: boolean } = {}) {
  let unlocks = 0;
  const driver: LockDriver = {
    kind: "fake",
    capabilities: { readState: false, vendorHistoryLabel: false },
    parseDevice: (d) => d,
    async unlock() {
      unlocks++;
      return { ok: true };
    },
  };
  const gate = createGate({
    doors: [{ id: "office", name: "Office", driver: "fake", device: {} }],
    drivers: { fake: driver },
    authorizer: { authorize: async () => (opts.allow === false ? { allow: false, reason: "no" } : { allow: true }) },
    audit: { record() {} },
  });
  return { gate, unlocks: () => unlocks };
}

function setup(opts: { principal?: Principal | null; allow?: boolean } = {}) {
  let unlocks = 0;
  const driver: LockDriver = {
    kind: "fake",
    capabilities: { readState: false, vendorHistoryLabel: false },
    parseDevice: (d) => d,
    async unlock() {
      unlocks++;
      return { ok: true };
    },
  };
  const gate = createGate({
    doors: [{ id: "office", name: "Office", driver: "fake", device: {} }],
    drivers: { fake: driver },
    authorizer: { authorize: async () => (opts.allow === false ? { allow: false, reason: "no" } : { allow: true }) },
    audit: { record() {} },
  });
  const seen: string[] = [];
  const authenticator: Authenticator = {
    async authenticate(req, { returnTo }) {
      seen.push(req.url);
      const p = opts.principal === undefined ? alice : opts.principal;
      if (p) return { ok: true, principal: p };
      return { ok: false, response: Response.redirect(`https://accounts.example.com/sign-in?redirect_url=${encodeURIComponent(returnTo)}`, 303) };
    },
  };
  const app = createKagiApp({ gate, authenticator, publicOrigin: ORIGIN });
  return { app, seen, unlocks: () => unlocks };
}

const post = (path: string, origin = ORIGIN) =>
  new Request(`http://internal${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: "",
  });

test("GET shows the button and never unlocks", async () => {
  const { app, seen, unlocks } = setup();
  const res = await app.request("http://internal/d/office");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('action="/d/office/unlock"');
  expect(html).toContain("Alice");
  expect(unlocks()).toBe(0);
  // The authenticator sees the public URL, not the proxy-internal one.
  expect(seen[0]).toBe(`${ORIGIN}/d/office`);
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("GET while signed out redirects to sign-in and back to the door", async () => {
  const { app } = setup({ principal: null });
  const res = await app.request("http://internal/d/office");
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toContain(encodeURIComponent(`${ORIGIN}/d/office`));
});

test("unknown door is 404", async () => {
  const { app } = setup();
  expect((await app.request("http://internal/d/nope")).status).toBe(404);
});

test("POST unlocks", async () => {
  const { app, unlocks } = setup();
  const res = await app.request(post("/d/office/unlock"));
  expect(res.status).toBe(200);
  expect(unlocks()).toBe(1);
});

test("POST from another origin is rejected", async () => {
  const { app, unlocks } = setup();
  const res = await app.request(post("/d/office/unlock", "https://evil.example"));
  expect(res.status).toBe(403);
  expect(unlocks()).toBe(0);
});

test("POST while signed out goes back to the door page, not through the sign-in redirect", async () => {
  const { app, unlocks } = setup({ principal: null });
  const res = await app.request(post("/d/office/unlock"));
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/d/office");
  expect(unlocks()).toBe(0);
});

test("/auth/* is delegated to the authenticator", async () => {
  const { gate } = setupGate();
  const authenticator: Authenticator = {
    authenticate: async () => ({ ok: true, principal: alice }),
    handle: async (req) => (new URL(req.url).pathname === "/auth/callback" ? new Response("cb") : null),
  };
  const app = createKagiApp({ gate, authenticator, publicOrigin: ORIGIN });
  expect(await (await app.request("http://internal/auth/callback?code=1")).text()).toBe("cb");
  expect((await app.request("http://internal/auth/other")).status).toBe(404);
});

test("API route exists only when configured, and uses its own authenticator", async () => {
  const { gate, unlocks } = setupGate();
  const browser: Authenticator = { authenticate: async () => ({ ok: true, principal: alice }) };
  expect((await createKagiApp({ gate, authenticator: browser, publicOrigin: ORIGIN }).request(post("/api/doors/office/unlock"))).status).toBe(404);

  const api: Authenticator = {
    authenticate: async (req) =>
      req.headers.get("authorization") === "Bearer good"
        ? { ok: true, principal: alice }
        : { ok: false, response: Response.json({ status: "unauthenticated" }, { status: 401 }) },
  };
  const app = createKagiApp({ gate, authenticator: browser, publicOrigin: ORIGIN, api });
  const bad = await app.request("http://internal/api/doors/office/unlock", { method: "POST" });
  expect(bad.status).toBe(401);
  expect(unlocks()).toBe(0);

  const ok = await app.request("http://internal/api/doors/office/unlock", { method: "POST", headers: { authorization: "Bearer good" } });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ status: "unlocked", verified: false });
  expect(unlocks()).toBe(1);
});

test("denied POST is 403", async () => {
  const { app, unlocks } = setup({ allow: false });
  const res = await app.request(post("/d/office/unlock"));
  expect(res.status).toBe(403);
  expect(unlocks()).toBe(0);
});

/** A gate that returns a fixed outcome and records who asked. */
function stubGate(outcome: UnlockOutcome) {
  const seen: Principal[] = [];
  const gate: Gate = {
    door: (id) => (id === "office" ? { id, name: "Office", driver: "fake", device: {} } : undefined),
    async unlock({ principal }) {
      seen.push(principal);
      return outcome;
    },
  };
  return { gate, seen };
}
const signedIn: Authenticator = { authenticate: async () => ({ ok: true, principal: alice }) };

test("a retryable failure offers Try again; an ambiguous one says check the door first", async () => {
  const retryable = createKagiApp({ gate: stubGate({ status: "failed", reason: "not_confirmed", retryable: true }).gate, authenticator: signedIn, publicOrigin: ORIGIN, messages: en });
  const html1 = await (await retryable.request(post("/d/office/unlock"))).text();
  expect(html1).toContain(en.failed.not_confirmed);
  expect(html1).toContain(`>${en.retry}<`);

  const ambiguous = createKagiApp({ gate: stubGate({ status: "failed", reason: "timeout", retryable: false, uncertain: true }).gate, authenticator: signedIn, publicOrigin: ORIGIN, messages: en });
  const html2 = await (await ambiguous.request(post("/d/office/unlock"))).text();
  expect(html2).toContain(en.checkDoorFirst);
  expect(html2).not.toContain(`>${en.retry}<`);

  // A clear, final refusal (nothing reached the lock) must not suggest the door may be open.
  const refused = createKagiApp({ gate: stubGate({ status: "failed", reason: "unauthorized", retryable: false }).gate, authenticator: signedIn, publicOrigin: ORIGIN, messages: en });
  const html3 = await (await refused.request(post("/d/office/unlock"))).text();
  expect(html3).toContain(en.failed.unauthorized);
  expect(html3).not.toContain(en.checkDoorFirst);
});

test("a press while the previous one is running says so (409), not a made-up wait time", async () => {
  const app = createKagiApp({ gate: stubGate({ status: "busy" }).gate, authenticator: signedIn, publicOrigin: ORIGIN, messages: en });
  const res = await app.request(post("/d/office/unlock"));
  expect(res.status).toBe(409);
  expect(await res.text()).toContain(en.busy);
});

test("the door page offers sign-out only when the authenticator supports it", async () => {
  const gate = stubGate({ status: "unknown_door" }).gate;
  const withLogout = createKagiApp({ gate, authenticator: { ...signedIn, logoutPath: "/auth/logout" }, publicOrigin: ORIGIN, messages: en });
  const html = await (await withLogout.request("http://internal/d/office")).text();
  expect(html).toContain('action="/auth/logout"');
  expect(html).toContain(`>${en.signOut}<`);
  const without = createKagiApp({ gate, authenticator: signedIn, publicOrigin: ORIGIN, messages: en });
  expect(await (await without.request("http://internal/d/office")).text()).not.toContain("/auth/logout");
});

test("the route, not the identity provider, says whether a request came from the web or the API", async () => {
  const { gate, seen } = stubGate({ status: "unlocked", verified: true });
  const sneaky: Authenticator = { authenticate: async () => ({ ok: true, principal: { ...alice, via: "api" } }) };
  const app = createKagiApp({ gate, authenticator: sneaky, publicOrigin: ORIGIN, api: sneaky });
  await app.request(post("/d/office/unlock"));
  await app.request("http://internal/api/doors/office/unlock", { method: "POST" });
  expect(seen.map((p) => p.via)).toEqual(["web", "api"]);
});

test("logout from another origin is rejected (CSRF)", async () => {
  const handled: string[] = [];
  const auth: Authenticator = {
    ...signedIn,
    handle: async (req) => {
      handled.push(req.method);
      return new Response("bye");
    },
  };
  const app = createKagiApp({ gate: stubGate({ status: "unknown_door" }).gate, authenticator: auth, publicOrigin: ORIGIN });
  expect((await app.request(post("/auth/logout", "https://evil.example"))).status).toBe(403);
  expect((await app.request(post("/auth/logout"))).status).toBe(200);
  expect(handled).toEqual(["POST"]);
});

test("behind a TLS-terminating proxy, the OIDC redirect_uri is the public https URL", async () => {
  const issuer = "https://id.example.com";
  const discovery = (async () =>
    Response.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    })) as unknown as typeof fetch;
  const authenticator = oidcAuthenticator({ issuer, clientId: "kagi", publicOrigin: ORIGIN, sessionSecret: "x".repeat(32), fetch: discovery });
  const app = createKagiApp({ gate: stubGate({ status: "unknown_door" }).gate, authenticator, publicOrigin: ORIGIN });
  // Cloud Run hands the app http://<internal host>/…
  const res = await app.request("http://10.0.0.7:8080/d/office");
  expect(res.status).toBe(303);
  const authorize = new URL(res.headers.get("location") ?? "");
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
  expect(res.headers.getSetCookie()[0]).toMatch(/^__Host-kagi_login_.*; Secure/);
});

test("the identity provider being down shows a 503 page on GET and POST", async () => {
  const down: Authenticator = {
    authenticate: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  };
  const app = createKagiApp({ gate: stubGate({ status: "unknown_door" }).gate, authenticator: down, publicOrigin: ORIGIN, messages: en });
  const get = await app.request("http://internal/d/office");
  expect(get.status).toBe(503);
  expect(await get.text()).toContain(en.unavailable);
  expect((await app.request(post("/d/office/unlock"))).status).toBe(503);
});
