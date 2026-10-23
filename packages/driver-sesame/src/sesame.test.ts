import { describe, expect, test } from "bun:test";
import type { CommandContext } from "@kagi/core";
import { aesCmac } from "./cmac.ts";
import { normalizeLockState, sesameDriver, sign } from "./index.ts";

describe("aesCmac (RFC 4493 vectors)", () => {
  const key = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex");
  const msg = Buffer.from(
    "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710",
    "hex",
  );
  test.each([
    [0, "bb1d6929e95937287fa37d129b756746"],
    [16, "070a16b46b4d4144f79bdd9dd04a287c"],
    [40, "dfa66747de9ae63030ca32611497c827"],
    [64, "51f0bebf7e3b9d92fc49741779363cfe"],
  ])("length %i", (len, expected) => {
    expect(aesCmac(key, msg.subarray(0, len)).toString("hex")).toBe(expected);
  });
});

test("sign uses bytes 1..3 of the little-endian timestamp", () => {
  const key = "2b7e151628aed2a6abf7158809cf4f3c";
  const t = 0x6543_2100;
  const expected = aesCmac(Buffer.from(key, "hex"), Buffer.from([0x21, 0x43, 0x65])).toString("hex");
  expect(sign(key, t)).toBe(expected);
  expect(sign(key, t + 0xff)).toBe(expected); // the low byte is not signed
});

test("normalizeLockState", () => {
  expect(normalizeLockState("locked")).toBe("locked");
  expect(normalizeLockState("unlocked")).toBe("unlocked");
  expect(normalizeLockState("moved")).toBe("unknown");
});

const UUID = "11111111-2222-3333-4444-555555555555";
const SECRET = "2b7e151628aed2a6abf7158809cf4f3c";
const ctx = (): CommandContext => ({
  actor: { id: "u1", displayName: "山田" },
  requestId: "r1",
  signal: new AbortController().signal,
});

function fakeFetch(status: number, body = "") {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("sesameDriver", () => {
  test("unlock posts cmd 83 with base64 history and sign", async () => {
    const { f, calls } = fakeFetch(200);
    const d = sesameDriver({ apiKey: "k", fetch: f, nowSeconds: () => 0x65432100 });
    const dev = d.parseDevice({ uuid: UUID, secretKey: SECRET });
    expect(await d.unlock(dev, ctx())).toEqual({ ok: true });
    expect(calls[0]?.url).toBe(`https://app.candyhouse.co/api/sesame2/${UUID}/cmd`);
    expect((calls[0]?.init.headers as Record<string, string>)["x-api-key"]).toBe("k");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      cmd: 83,
      history: Buffer.from("山田").toString("base64"),
      sign: sign(SECRET, 0x65432100),
    });
  });

  test("maps HTTP errors", async () => {
    for (const [status, reason] of [
      [403, "unauthorized"],
      [404, "invalid_device"],
      [429, "rate_limited"],
      [502, "vendor_error"],
    ] as const) {
      const d = sesameDriver({ apiKey: "k", fetch: fakeFetch(status).f });
      const r = await d.unlock(d.parseDevice({ uuid: UUID, secretKey: SECRET }), ctx());
      expect(r.ok ? null : r.reason).toBe(reason);
    }
  });

  test("getState reads CHSesame2Status", async () => {
    const d = sesameDriver({ apiKey: "k", fetch: fakeFetch(200, JSON.stringify({ CHSesame2Status: "unlocked" })).f });
    expect(await d.getState?.(d.parseDevice({ uuid: UUID, secretKey: SECRET }), ctx())).toBe("unlocked");
  });

  test("parseDevice rejects bad config", () => {
    const d = sesameDriver({ apiKey: "k" });
    expect(() => d.parseDevice({ uuid: "nope", secretKey: SECRET })).toThrow();
    expect(() => d.parseDevice({ uuid: UUID, secretKey: "short" })).toThrow();
  });
});
