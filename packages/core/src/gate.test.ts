import { describe, expect, test } from "bun:test";
import { createGate } from "./gate.ts";
import type { AuditEvent, Authorizer, CommandResult, GateOptions, LockDriver, LockState, Principal } from "./types.ts";

const alice: Principal = { id: "u_alice", displayName: "Alice", claims: {} };
const allow: Authorizer = { authorize: async () => ({ allow: true }) };

function fakeDriver(opts: { result?: CommandResult; states?: LockState[]; readState?: boolean; hang?: boolean } = {}) {
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
      return opts.result ?? { ok: true };
    },
    async getState() {
      calls.getState++;
      return states.shift() ?? "unknown";
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

  test("driver failure is passed through", async () => {
    const { g } = gate(fakeDriver({ result: { ok: false, reason: "device_offline", retryable: true } }).driver);
    expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "failed", reason: "device_offline", retryable: true });
  });

  test("a hanging driver times out", async () => {
    const { g } = gate(fakeDriver({ hang: true }).driver, { commandTimeoutMs: 10 });
    expect(await g.unlock({ principal: alice, doorId: "office" })).toEqual({ status: "failed", reason: "timeout", retryable: true });
  });

  test("double tap hits the cooldown and sends one command", async () => {
    const { driver, calls } = fakeDriver({ readState: false });
    const { g } = gate(driver);
    const [a, b] = await Promise.all([g.unlock({ principal: alice, doorId: "office" }), g.unlock({ principal: alice, doorId: "office" })]);
    expect(a.status).toBe("unlocked");
    expect(b.status).toBe("cooldown");
    expect(calls.unlock).toBe(1);
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
