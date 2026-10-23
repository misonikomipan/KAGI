import { expect, test } from "bun:test";
import type { AuthorizationInput } from "@kagi/core";
import { loadConfig } from "./config.ts";

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

test("the API is enabled by KAGI_API_JWT_ISSUER", () => {
  expect(loadConfig({ ...base, KAGI_API_JWT_ISSUER: "https://clerk.example.com" }).api).toBeDefined();
});

test("fails loudly on missing or malformed settings", () => {
  expect(() => loadConfig({ ...base, OIDC_CLIENT_ID: undefined })).toThrow(/OIDC_CLIENT_ID/);
  expect(() => loadConfig({ ...base, KAGI_SESSION_SECRET: "short" })).toThrow(/32/);
  expect(() => loadConfig({ ...base, KAGI_DOORS: "{" })).toThrow(/not valid JSON/);
  expect(() => loadConfig({ ...base, SWITCHBOT_TOKEN: "t" })).toThrow(/SWITCHBOT_SECRET/);
  expect(() => loadConfig({ ...base, KAGI_AUTH: "saml" })).toThrow(/KAGI_AUTH/);
});
