import { expect, test } from "bun:test";
import type { AuthorizationInput } from "@kagi/core";
import { loadConfig, sessionClaims } from "./config.ts";

const base = {
  KAGI_PUBLIC_ORIGIN: "https://door.example.com/",
  KAGI_DOORS: JSON.stringify([{ id: "home", name: "Home", driver: "sesame", device: {} }]),
  OIDC_ISSUER: "https://id.example.com",
  OIDC_CLIENT_ID: "kagi",
  KAGI_SESSION_SECRET: "x".repeat(32),
  SESAME_API_KEY: "k",
};

const input = (claims: Record<string, unknown>): AuthorizationInput => ({
  principal: { id: "u", displayName: "U", claims },
  door: { id: "home", name: "Home", driver: "sesame", device: {} },
  now: new Date(),
});

test("OIDC is the default, authorizing by groups like door:home", async () => {
  const c = loadConfig(base);
  expect(c.publicOrigin).toBe("https://door.example.com");
  expect(Object.keys(c.drivers)).toEqual(["sesame"]);
  expect(c.api).toBeUndefined();
  expect(await c.authorizer.authorize(input({ groups: ["door:home"] }))).toEqual({ allow: true });
  expect((await c.authorizer.authorize(input({ groups: ["home"] }))).allow).toBe(false);
});

test("Clerk authorizes by publicMetadata.doors", async () => {
  const c = loadConfig({ ...base, KAGI_AUTH: "clerk", CLERK_SECRET_KEY: "sk_test_x", CLERK_PUBLISHABLE_KEY: "pk_test_x" });
  expect(await c.authorizer.authorize(input({ publicMetadata: { doors: ["home"] } }))).toEqual({ allow: true });
});

test("the API is enabled by KAGI_API_JWT_ISSUER, and refuses to start without aud or azp", () => {
  expect(() => loadConfig({ ...base, KAGI_API_JWT_ISSUER: "https://clerk.example.com" })).toThrow(/AUDIENCE|AUTHORIZED_PARTIES/);
  expect(loadConfig({ ...base, KAGI_API_JWT_ISSUER: "https://clerk.example.com", KAGI_API_JWT_AUTHORIZED_PARTIES: "https://hcm.example.com" }).api).toBeDefined();
  expect(loadConfig({ ...base, KAGI_API_JWT_ISSUER: "https://id.example.com", KAGI_API_JWT_AUDIENCE: "kagi-api" }).api).toBeDefined();
});

test("API callers can be authorized by a different claim than the door page", async () => {
  const c = loadConfig({ ...base, KAGI_API_JWT_ISSUER: "https://clerk.example.com", KAGI_API_JWT_AUTHORIZED_PARTIES: "https://hcm.example.com", KAGI_API_ALLOW_CLAIM: "metadata.doors", KAGI_API_ALLOW_PREFIX: "" });
  const web = input({ groups: ["door:home"] });
  const api = (claims: Record<string, unknown>) => ({ ...input(claims), principal: { ...input(claims).principal, via: "api" as const } });
  expect(await c.authorizer.authorize(web)).toEqual({ allow: true });
  expect(await c.authorizer.authorize(api({ metadata: { doors: ["home"] } }))).toEqual({ allow: true });
  // A web-style claim does not open the door through the API, and vice versa.
  expect((await c.authorizer.authorize(api({ groups: ["door:home"] }))).allow).toBe(false);
  expect((await c.authorizer.authorize(input({ metadata: { doors: ["home"] } }))).allow).toBe(false);
});

test("the session keeps the allow-list claim by its top-level key, narrowed to the allow prefix", () => {
  expect(sessionClaims("groups", "door:")).toEqual({ keepClaims: ["groups"], narrowClaim: { path: "groups", prefix: "door:" } });
  expect(sessionClaims("publicMetadata.doors", "")).toEqual({ keepClaims: ["publicMetadata"], narrowClaim: { path: "publicMetadata.doors", prefix: "" } });
});

test("door ids follow the core rule (no '.', '..', non-ASCII)", () => {
  for (const id of [".", "..", "玄関"]) {
    expect(() => loadConfig({ ...base, KAGI_DOORS: JSON.stringify([{ id, name: "A", driver: "sesame", device: {} }]) })).toThrow(/\.id/);
  }
});

test("fails loudly on missing or malformed settings", () => {
  expect(() => loadConfig({ ...base, OIDC_CLIENT_ID: undefined })).toThrow(/OIDC_CLIENT_ID/);
  expect(() => loadConfig({ ...base, KAGI_SESSION_SECRET: "short" })).toThrow(/32/);
  expect(() => loadConfig({ ...base, KAGI_DOORS: "{" })).toThrow(/not valid JSON/);
  expect(() => loadConfig({ ...base, KAGI_DOORS: '[{"id":"a b","name":"A","driver":"sesame"}]' })).toThrow(/\.id/);
  expect(() => loadConfig({ ...base, KAGI_DOORS: '[{"id":"a","driver":"sesame"}]' })).toThrow(/\.name/);
  expect(() => loadConfig({ ...base, SWITCHBOT_TOKEN: "t" })).toThrow(/SWITCHBOT_SECRET/);
  expect(() => loadConfig({ ...base, KAGI_AUTH: "saml" })).toThrow(/KAGI_AUTH/);
  expect(() => loadConfig({ ...base, KAGI_SESSION_TTL_SECONDS: "abc" })).toThrow(/KAGI_SESSION_TTL_SECONDS/);
  expect(() => loadConfig({ ...base, KAGI_SESSION_TTL_SECONDS: "-5" })).toThrow(/positive integer/);
  expect(() => loadConfig({ ...base, PORT: "http" })).toThrow(/PORT/);
});
