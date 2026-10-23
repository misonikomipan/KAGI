import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { CommandContext } from "@kagi/core";
import { normalizeLockState, SwitchBotClient, switchbotDriver } from "./index.ts";

const ctx = (): CommandContext => ({
  actor: { id: "u1", displayName: "Yamada" },
  requestId: "r1",
  signal: new AbortController().signal,
});

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("headers sign token + t + nonce with HMAC-SHA256 (base64)", () => {
  const h = new SwitchBotClient({ token: "tok", secret: "sec" }).headers(1700000000000, "n-1");
  expect(h.sign).toBe(createHmac("sha256", "sec").update("tok1700000000000n-1").digest("base64"));
  expect(h).toMatchObject({ authorization: "tok", t: "1700000000000", nonce: "n-1" });
});

test("normalizeLockState covers every model's spelling", () => {
  expect(normalizeLockState("lock")).toBe("locked");
  expect(normalizeLockState("LOCKED")).toBe("locked");
  expect(normalizeLockState("latchBoltLocked")).toBe("locked");
  expect(normalizeLockState("unlock")).toBe("unlocked");
  expect(normalizeLockState("jammed")).toBe("jammed");
  expect(normalizeLockState(undefined)).toBe("unknown");
});

describe("switchbotDriver", () => {
  const dev = { deviceId: "A1B2C3D4E5F6" };

  test("unlock posts the unlock command", async () => {
    const { f, calls } = fakeFetch(200, { statusCode: 100, message: "success", body: {} });
    const d = switchbotDriver({ token: "t", secret: "s", fetch: f });
    expect(await d.unlock(d.parseDevice(dev), ctx())).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://api.switch-bot.com/v1.1/devices/A1B2C3D4E5F6/commands");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ command: "unlock", parameter: "default", commandType: "command" });
  });

  test("maps vendor status codes", async () => {
    for (const [http, statusCode, reason] of [
      [200, 161, "device_offline"],
      [200, 171, "device_offline"],
      [200, 152, "invalid_device"],
      [200, 190, "vendor_error"],
      [401, 0, "unauthorized"],
      [429, 0, "rate_limited"],
    ] as const) {
      const d = switchbotDriver({ token: "t", secret: "s", fetch: fakeFetch(http, { statusCode, message: "x", body: {} }).f });
      const r = await d.unlock(dev, ctx());
      expect(r.ok ? null : r.reason).toBe(reason);
    }
  });

  test("getState normalizes lockState", async () => {
    const { f } = fakeFetch(200, { statusCode: 100, message: "success", body: { lockState: "unlock" } });
    const d = switchbotDriver({ token: "t", secret: "s", fetch: f });
    expect(await d.getState?.(dev, ctx())).toBe("unlocked");
  });

  test("aborted fetch becomes timeout", async () => {
    const f = (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    const r = await switchbotDriver({ token: "t", secret: "s", fetch: f }).unlock(dev, ctx());
    expect(r).toEqual({ ok: false, reason: "timeout", retryable: true });
  });

  test("parseDevice rejects bad ids", () => {
    expect(() => switchbotDriver({ token: "t", secret: "s" }).parseDevice({ deviceId: "x" })).toThrow();
  });
});
