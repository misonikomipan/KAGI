import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createGate } from "./gate.ts";
import { type AuditEvent, type Authorizer, type CommandResult, type GateOptions, isValidDoorId, type LockDriver, type LockReading, type LockState, type Principal } from "./types.ts";

const alice: Principal = { id: "u_alice", displayName: "Alice", claims: {} };
const allow: Authorizer = { authorize: async () => ({ allow: true }) };

/** Captures the gate's JSON log lines (console.error) for one test. */
function captureLogs() {
  const lines: string[] = [];
  const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(" ")));
  afterEach(() => spy.mockRestore());
  return { lines, restore: () => spy.mockRestore() };
}

function fakeDriver(
  opts: { result?: CommandResult; states?: Array<LockState | LockReading | "throw" | "hang">; readState?: boolean; hang?: boolean; throws?: boolean; delayMs?: number } = {},
) {
  const states = [...(opts.states ?? [])];
  const calls = { unlock: 0, getState: 0 };
  const driver: LockDriver<string> = {
    kind: "fake",
    capabilities: { readState: opts.readState ?? true, vendorHistoryLabel: false },
    parseDevice(d) {
      if (typeof d !== "string") throw new Error("device must be a string");
      return d;
    },
    async unlock() {
      calls.unlock++;
      if (opts.hang) await new Promise(() => {});
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.throws) throw new Error("socket hang up");
      return opts.result ?? { ok: true };
    },
    async getState() {
      calls.getState++;
      const s = states.shift() ?? "unknown";
      if (s === "throw") throw new Error("HTTP 429");
      if (s === "hang") await new Promise(() => {});
      return s as LockState | LockReading;
    },
  };
  return { driver, calls };
}

function gate(driver: LockDriver<string>, extra: Partial<GateOptions> = {}) {
  const events: AuditEvent[] = [];
  const g = createGate({
    doors: [{ id: "office", name: "Office", driver: "fake", device: "dev-1" }],
    drivers: { fake: driver as LockDriver },
    authorizer: allow,
    audit: { record: (e) => void events.push(e) },
    verify: { timeoutMs: 50, intervalMs: 1 },
    ...extra,
  });
  return { g, events };
}

describe("createGate", () => {
  test("rejects bad config at startup", () => {
    const { driver } = fakeDriver();
    expect(() => createGate({ doors: [{ id: "a", name: "A", driver: "nope", device: "x" }], drivers: { fake: driver as LockDriver }, authorizer: allow })).toThrow(/unknown driver/);
    expect(() => createGate({ doors: [{ id: "a", name: "A", driver: "fake", device: 1 }], drivers: { fake: driver as LockDriver }, authorizer: allow })).toThrow(/invalid device/);
  });

  test("unknown door", async () => {
    const { g } = gate(fakeDriver().driver);
    expect(await g.unlock({ principal: alice, doorId: "nope" })).toEqual({ status: "unknown_door" });
  });

  test("unlocks and verifies", async () => {
    const { driver, calls } = fakeDriver({ states: ["locked", "unlocked"] });
    const { g, events } = gate(driver);
    expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "unlocked", verified: true });
    expect(calls.getState).toBe(2);
    expect(events.map((e) => e.type)).toEqual(["unlock.succeeded"]);
  });

  test("unverified when the state never reads unlocked", async () => {
    const { g } = gate(fakeDriver({ states: [] }).driver);
    expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "unlocked", verified: false });
  });

  test("no polling when the driver cannot read state", async () => {
    const { driver, calls } = fakeDriver({ readState: false });
    const { g } = gate(driver);
    expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "unlocked", verified: false });
    expect(calls.getState).toBe(0);
  });

  test("jammed after the command is a failure", async () => {
    const { g, events } = gate(fakeDriver({ states: ["jammed"] }).driver);
    expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "failed", reason: "jammed", retryable: false });
    expect(events[0]?.type).toBe("unlock.failed");
  });

  test("denied never reaches the driver", async () => {
    const { driver, calls } = fakeDriver();
    const { g, events } = gate(driver, { authorizer: { authorize: async () => ({ allow: false, reason: "nope" }) } });
    expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "denied", reason: "nope" });
    expect(calls.unlock).toBe(0);
    expect(events[0]).toMatchObject({ type: "unlock.denied", reason: "nope" });
  });

  test("a throwing authorizer fails closed", async () => {
    const { g } = gate(fakeDriver().driver, {
      authorizer: {
        authorize: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(await g.unlock({ principal: alice, doorId: "office" })).toMatchObject({ status: "denied" });
  });

  test("a definite driver failure is passed through without reading the state", async () => {
    const { driver, calls } = fakeDriver({ result: { ok: false, reason: "device_offline", retryable: true } });
    const { g } = gate(driver);
    expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "failed", reason: "device_offline", retryable: true });
    expect(calls.getState).toBe(0);
  });

  test("still locked after the command is not_confirmed, not success", async () => {
    const { g, events } = gate(fakeDriver({ states: ["locked", "locked", "locked"] }).driver);
    expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "failed", reason: "not_confirmed", retryable: true });
    expect(events.map((e) => e.type)).toEqual(["unlock.failed"]);
  });

  test("state reads that fail count as unknown (verified=false), and are logged", async () => {
    const { g } = gate(fakeDriver({ states: ["throw", "throw"] }).driver);
    expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "unlocked", verified: false });
  });

  test("a hanging state read does not hang the unlock", async () => {
    const { g } = gate(fakeDriver({ states: ["hang"] }).driver, { commandTimeoutMs: 10 });
    expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "unlocked", verified: false });
  });

  describe("command timeout or error: the command may have gone through", () => {
    test("reads unlocked afterwards → success", async () => {
      const { g, events } = gate(fakeDriver({ hang: true, states: ["unlocked"] }).driver, { commandTimeoutMs: 10 });
      expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "unlocked", verified: true });
      expect(events.map((e) => e.type)).toEqual(["unlock.succeeded"]);
    });

    test("reads locked afterwards → failed, safe to retry", async () => {
      const { g } = gate(fakeDriver({ throws: true, states: ["locked"] }).driver);
      expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "failed", reason: "vendor_error", retryable: true });
    });

    test("state unknown afterwards → failed, NOT retryable, uncertain (the door may be open)", async () => {
      const { g } = gate(fakeDriver({ hang: true, states: [] }).driver, { commandTimeoutMs: 10 });
      expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "failed", reason: "timeout", retryable: false, uncertain: true });
    });

    test("driver that cannot read state → failed, NOT retryable, uncertain", async () => {
      const { driver, calls } = fakeDriver({ hang: true, readState: false });
      const { g } = gate(driver, { commandTimeoutMs: 10 });
      expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "failed", reason: "timeout", retryable: false, uncertain: true });
      expect(calls.getState).toBe(0);
    });

    test("a driver result marked ambiguous (HTTP 5xx) is read back too", async () => {
      const { driver, calls } = fakeDriver({ result: { ok: false, reason: "vendor_error", retryable: true, ambiguous: true, detail: "HTTP 502" }, states: ["unlocked"] });
      const { g, events } = gate(driver);
      expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "unlocked", verified: true });
      expect(calls.getState).toBe(1);
      // The unclear failure that preceded the success stays in the audit trail.
      expect(events[0]).toMatchObject({ type: "unlock.succeeded", verified: true, detail: "HTTP 502" });
    });
  });

  test("a clear refusal (4xx) is not read back, and keeps the driver's retryable", async () => {
    const { driver, calls } = fakeDriver({ result: { ok: false, reason: "vendor_error", retryable: false, detail: "HTTP 400: bad sign" }, states: ["locked"] });
    const { g, events } = gate(driver);
    expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "failed", reason: "vendor_error", retryable: false });
    expect(calls.getState).toBe(0);
    expect(events[0]).toMatchObject({ type: "unlock.failed", reason: "vendor_error", detail: "HTTP 400: bad sign" });
  });

  describe("stale readings (observed before the command) do not count", () => {
    const old = () => new Date(Date.now() - 60_000);
    test("a stale 'unlocked' is not verified; a fresh one is", async () => {
      const stale = gate(fakeDriver({ states: [{ state: "unlocked", observedAt: old() }] }).driver);
      expect(await stale.g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "unlocked", verified: false });
      const fresh = gate(fakeDriver({ states: [{ state: "unlocked", observedAt: old() }, { state: "unlocked", observedAt: new Date() }] }).driver);
      expect(await fresh.g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "unlocked", verified: true });
    });

    test("a stale 'locked' is not not_confirmed", async () => {
      const { g } = gate(fakeDriver({ states: [{ state: "locked", observedAt: old() }] }).driver);
      expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "unlocked", verified: false });
    });

    test("readings within the clock skew count", async () => {
      const { g } = gate(fakeDriver({ states: [{ state: "unlocked", observedAt: new Date(Date.now() - 1_000) }] }).driver);
      expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "unlocked", verified: true });
    });

    test("only stale readings are logged", async () => {
      const logs = captureLogs();
      const { g } = gate(fakeDriver({ states: [{ state: "unlocked", observedAt: old() }] }).driver);
      await g.unlock({ principal: alice, doorId: "office" });
      logs.restore();
      expect(logs.lines.some((l) => l.includes("older than the command"))).toBe(true);
    });
  });

  test("state read failures and timeouts are logged with the request id", async () => {
    const logs = captureLogs();
    const { g } = gate(fakeDriver({ states: ["throw", "hang"] }).driver, { commandTimeoutMs: 10 });
    await g.unlock({ principal: alice, doorId: "office", requestId: "req-1" });
    logs.restore();
    expect(logs.lines.some((l) => l.includes("reading lock state failed") && l.includes("req-1") && l.includes("HTTP 429"))).toBe(true);
    expect(logs.lines.some((l) => l.includes("reading lock state timed out") && l.includes("req-1"))).toBe(true);
  });

  test("audit events carry the entry point (via)", async () => {
    const { g, events } = gate(fakeDriver({ readState: false }).driver);
    await g.unlock({ principal: { ...alice, via: "api" }, doorId: "office" });
    expect(events[0]).toMatchObject({ type: "unlock.succeeded", via: "api" });
  });

  test("door ids: plain ASCII URL segments, not '.' or '..'", () => {
    for (const ok of ["office", "front-door", "b1_2", "v1.2"]) expect(isValidDoorId(ok)).toBe(true);
    for (const bad of ["", ".", "..", "玄関", "a b", "a/b", "x".repeat(65)]) expect(isValidDoorId(bad)).toBe(false);
    const { driver } = fakeDriver();
    expect(() => createGate({ doors: [{ id: "..", name: "A", driver: "fake", device: "x" }], drivers: { fake: driver as LockDriver }, authorizer: allow })).toThrow(/door id/);
  });

  test("a second press while the first is running is 'busy'; one command is sent", async () => {
    const { driver, calls } = fakeDriver({ readState: false, delayMs: 20 });
    const { g } = gate(driver, { cooldownMs: 0 });
    const [a, b] = await Promise.all([g.unlock({ principal: alice, doorId: "office" }), g.unlock({ principal: alice, doorId: "office" })]);
    expect(a.status).toBe("unlocked");
    expect(b).toEqual({ status: "busy" });
    expect(calls.unlock).toBe(1);
  });

  test("cooldown follows a success", async () => {
    const { driver, calls } = fakeDriver({ readState: false });
    const { g } = gate(driver);
    expect((await g.unlock({ principal: alice, doorId: "office" })).status).toBe("unlocked");
    expect((await g.unlock({ principal: alice, doorId: "office" })).status).toBe("cooldown");
    expect(calls.unlock).toBe(1);
  });

  test("a short cooldown follows a failure, so repeated presses do not burn the vendor's quota", async () => {
    const { driver, calls } = fakeDriver({ result: { ok: false, reason: "device_offline", retryable: true } });
    const { g } = gate(driver, { failureCooldownMs: 2_000 });
    expect((await g.unlock({ principal: alice, doorId: "office" })).status).toBe("failed");
    const again = await g.unlock({ principal: alice, doorId: "office" });
    expect(again.status).toBe("cooldown");
    expect(again.status === "cooldown" && again.retryAfterMs).toBeLessThanOrEqual(2_000);
    expect(calls.unlock).toBe(1);
  });

  test("with failureCooldownMs 0, Try again works at once", async () => {
    const { driver, calls } = fakeDriver({ result: { ok: false, reason: "device_offline", retryable: true } });
    const { g } = gate(driver, { failureCooldownMs: 0 });
    expect((await g.unlock({ principal: alice, doorId: "office" })).status).toBe("failed");
    expect((await g.unlock({ principal: alice, doorId: "office" })).status).toBe("failed");
    expect(calls.unlock).toBe(2);
  });

  test("a throwing audit sink does not break unlock", async () => {
    const { driver } = fakeDriver({ readState: false });
    const g = createGate({
      doors: [{ id: "office", name: "Office", driver: "fake", device: "d" }],
      drivers: { fake: driver as LockDriver },
      authorizer: allow,
      audit: {
        record() {
          throw new Error("sink down");
        },
      },
    });
    expect((await g.unlock({ principal: alice, doorId: "office" })).status).toBe("unlocked");
  });
});
