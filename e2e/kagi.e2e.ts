// End-to-end: a real Pocket ID (Docker), the real KAGI app and OIDC sign-in, a real browser.
// Only the lock is fake. Run with `bun run e2e` (starts and stops Pocket ID).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { oidcAuthenticator } from "@kagi/auth-oidc";
import { type AuditEvent, claimAllowList, createGate, type LockDriver } from "@kagi/core";
import { createKagiApp, en } from "@kagi/server";
import { type Browser, chromium, type Page } from "playwright";

const POCKET_ID = "http://localhost:1411";
const API_KEY = "kagi-e2e-static-api-key";
const KAGI_PORT = 18090;
const KAGI = `http://localhost:${KAGI_PORT}`;
const run = crypto.randomUUID().slice(0, 8); // unique names, so the suite can rerun against one Pocket ID

async function admin<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${POCKET_ID}/api${path}`, {
    method,
    headers: { "x-api-key": API_KEY, "content-type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`Pocket ID ${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** A one-time sign-in link, from Pocket ID's own CLI (no passkey needed). */
async function signInLink(username: string): Promise<string> {
  const p = Bun.spawn(["docker", "compose", "-f", "e2e/compose.yml", "exec", "-T", "pocket-id", "/app/pocket-id", "one-time-access-token", username]);
  const out = await new Response(p.stdout).text();
  const link = /https?:\/\/\S+\/lc\/\S+/.exec(out)?.[0];
  if (!link) throw new Error(`no sign-in link in: ${out}`);
  return link;
}

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let unlocks = 0;
const audit: AuditEvent[] = [];
const users = { alice: `alice-${run}`, bob: `bob-${run}` };

beforeAll(async () => {
  // People and groups at the provider: alice may open "home", bob may not.
  const group = await admin<{ id: string }>("POST", "/user-groups", { friendlyName: `Door home ${run}`, name: "door:home" }).catch(
    async () => (await admin<{ data: Array<{ id: string; name: string }> }>("GET", "/user-groups?search=door:home")).data[0] as { id: string },
  );
  const alice = await admin<{ id: string }>("POST", "/users", { username: users.alice, email: `${users.alice}@example.com`, emailVerified: true, firstName: "Alice", lastName: "E2E", displayName: "Alice E2E" });
  await admin("POST", "/users", { username: users.bob, email: `${users.bob}@example.com`, emailVerified: true, firstName: "Bob", lastName: "E2E", displayName: "Bob E2E" });
  const members = (await admin<{ users: Array<{ id: string }> }>("GET", `/user-groups/${group.id}`)).users.map((u) => u.id);
  await admin("PUT", `/user-groups/${group.id}/users`, { userIds: [...members, alice.id] });

  // KAGI as a public OIDC client with PKCE.
  const client = await admin<{ id: string }>("POST", "/oidc/clients", {
    name: `KAGI e2e ${run}`,
    callbackURLs: [`${KAGI}/auth/callback`],
    isPublic: true,
    pkceEnabled: true,
    skipConsent: true,
  });

  // The real app, with only the lock faked.
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
    doors: [{ id: "home", name: "Home", driver: "fake", device: {} }],
    drivers: { fake: driver },
    authorizer: claimAllowList("groups", { prefix: "door:" }),
    audit: { record: (e) => void audit.push(e) },
    cooldownMs: 0,
  });
  const authenticator = oidcAuthenticator({
    issuer: POCKET_ID,
    clientId: client.id,
    publicOrigin: KAGI,
    sessionSecret: "e2e-session-secret-0123456789abcdef",
    scopes: "openid profile email groups",
    allowInsecureIssuer: true,
  });
  server = Bun.serve({ port: KAGI_PORT, fetch: createKagiApp({ gate, authenticator, publicOrigin: KAGI, messages: en }).fetch });

  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

async function signedInPage(username: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(await signInLink(username));
  // Pocket ID goes /lc/<token> → /login/alternative/code → its own UI (for a user without a
  // passkey: /signup/add-passkey). Only the last step means the session exists.
  await page.waitForURL((u) => !u.pathname.startsWith("/lc/") && !u.pathname.startsWith("/login"), { timeout: 15_000 });
  return page;
}

test("a member of door:home signs in through Pocket ID and unlocks", async () => {
  const page = await signedInPage(users.alice);
  const before = unlocks;

  // Opening the door URL bounces through Pocket ID and back, and never unlocks by itself.
  await page.goto(`${KAGI}/d/home`);
  await page.waitForURL(`${KAGI}/d/home`, { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Unlock" }).isVisible()).resolves.toBe(true);
  expect(await page.textContent("body")).toContain("Alice E2E");
  expect(unlocks).toBe(before);

  await page.getByRole("button", { name: "Unlock" }).click();
  await page.waitForLoadState();
  // The fake lock cannot read its state, so KAGI honestly says "sent", not "unlocked".
  expect(await page.getByRole("status").textContent()).toBe(en.unlockedUnverified);
  expect(unlocks).toBe(before + 1);
  expect(audit.at(-1)).toMatchObject({ type: "unlock.succeeded", doorId: "home" });
}, 60_000);

test("someone outside door:home is signed in but denied", async () => {
  const page = await signedInPage(users.bob);
  const before = unlocks;
  await page.goto(`${KAGI}/d/home`);
  await page.waitForURL(`${KAGI}/d/home`, { timeout: 15_000 });
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.waitForLoadState();
  expect(await page.getByRole("status").textContent()).toBe(en.denied);
  expect(unlocks).toBe(before);
  expect(audit.at(-1)).toMatchObject({ type: "unlock.denied", doorId: "home" });
}, 60_000);

test("the Sign out button signs out; afterwards the door page asks Pocket ID again", async () => {
  const page = await signedInPage(users.alice);
  await page.goto(`${KAGI}/d/home`);
  await page.waitForURL(`${KAGI}/d/home`, { timeout: 15_000 });

  // Logout is POST-only (CSRF check); a GET must not sign anyone out.
  expect(await page.evaluate(async () => (await fetch("/auth/logout")).status)).toBe(404);

  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${KAGI}/auth/logout`, { timeout: 15_000 });
  expect(await page.textContent("body")).toContain("Signed out");
  await page.goto(`${KAGI}/d/home`);
  await page.waitForURL(`${KAGI}/d/home`, { timeout: 15_000 });
  // Still signed in at Pocket ID, so it comes straight back, but via the provider.
  expect(requests.some((u) => u.startsWith(`${POCKET_ID}/authorize`))).toBe(true);
}, 60_000);
