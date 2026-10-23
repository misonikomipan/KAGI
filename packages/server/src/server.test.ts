import { expect, test } from "bun:test";
import { type Authenticator, createGate, type LockDriver, type Principal } from "@kagi/core";
import { createKagiApp } from "./index.tsx";

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
