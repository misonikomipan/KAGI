import { expect, test } from "bun:test";
import { allOf, anyOf, claimAllowList, httpAuthorizer, timeWindow } from "./authorizers.ts";
import type { AuthorizationInput } from "./types.ts";

const input = (claims: Record<string, unknown> = {}, now = new Date("2026-10-23T01:00:00Z")): AuthorizationInput => ({
  principal: { id: "u1", displayName: "U", claims },
  door: { id: "office", name: "Office", driver: "fake", device: null },
  now,
});

test("claimAllowList", async () => {
  const a = claimAllowList("publicMetadata.doors");
  expect(await a.authorize(input({ publicMetadata: { doors: ["office"] } }))).toEqual({ allow: true });
  expect(await a.authorize(input({ publicMetadata: { doors: ["*"] } }))).toEqual({ allow: true });
  expect((await a.authorize(input({ publicMetadata: { doors: ["home"] } }))).allow).toBe(false);
  expect((await a.authorize(input({}))).allow).toBe(false);
});

test("timeWindow in Asia/Tokyo, including overnight windows", async () => {
  // 2026-10-23 is a Friday. 01:00Z = 10:00 JST.
  const day = timeWindow({ timeZone: "Asia/Tokyo", windows: [{ days: ["fri"], start: "09:00", end: "18:00" }] });
  expect((await day.authorize(input())).allow).toBe(true);
  expect((await day.authorize(input({}, new Date("2026-10-23T10:00:00Z")))).allow).toBe(false); // 19:00 JST

  const night = timeWindow({ timeZone: "Asia/Tokyo", windows: [{ days: ["fri"], start: "22:00", end: "06:00" }] });
  expect((await night.authorize(input({}, new Date("2026-10-23T14:00:00Z")))).allow).toBe(true); // Fri 23:00
  expect((await night.authorize(input({}, new Date("2026-10-23T19:00:00Z")))).allow).toBe(true); // Sat 04:00
  expect((await night.authorize(input({}, new Date("2026-10-22T19:00:00Z")))).allow).toBe(false); // Fri 04:00
});

test("allOf / anyOf", async () => {
  const yes = { authorize: async () => ({ allow: true }) as const };
  const no = (r: string) => ({ authorize: async () => ({ allow: false, reason: r }) as const });
  expect(await allOf(yes, no("a")).authorize(input())).toEqual({ allow: false, reason: "a" });
  expect(await anyOf(no("a"), yes).authorize(input())).toEqual({ allow: true });
  expect(await anyOf(no("a"), no("b")).authorize(input())).toEqual({ allow: false, reason: "a; b" });
});

test("httpAuthorizer fails closed", async () => {
  const ok = (async () => Response.json({ allow: true })) as unknown as typeof fetch;
  const broken = (async () => {
    throw new Error("down");
  }) as unknown as typeof fetch;
  const garbage = (async () => new Response("not json")) as unknown as typeof fetch;
  expect(await httpAuthorizer({ url: "https://x", fetch: ok }).authorize(input())).toEqual({ allow: true });
  expect((await httpAuthorizer({ url: "https://x", fetch: broken }).authorize(input())).allow).toBe(false);
  expect((await httpAuthorizer({ url: "https://x", fetch: garbage }).authorize(input())).allow).toBe(false);
});
