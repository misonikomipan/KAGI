import { recordSafely, stdoutAuditSink } from "./audit.ts";
import {
  type CommandContext,
  type CommandFailureReason,
  type CommandResult,
  type DoorConfig,
  type Gate,
  type GateOptions,
  isValidDoorId,
  type LockDriver,
  type LockReading,
  type LockState,
  type Principal,
  type UnlockOutcome,
} from "./types.ts";

interface ResolvedDoor {
  config: DoorConfig;
  driver: LockDriver;
  device: unknown;
}

type Failure = Extract<CommandResult, { ok: false }>;

const TIMED_OUT = Symbol("timed out");

/**
 * Builds the orchestrator. Validates every door against its driver up front, so a typo in the
 * configuration fails at startup rather than at the door.
 */
export function createGate(opts: GateOptions): Gate {
  const audit = opts.audit ?? stdoutAuditSink();
  const commandTimeoutMs = opts.commandTimeoutMs ?? 10_000;
  const verify = { clockSkewMs: 2_000, ...(opts.verify ?? { timeoutMs: 8_000, intervalMs: 1_000 }) };
  const cooldownMs = opts.cooldownMs ?? 5_000;
  const failureCooldownMs = opts.failureCooldownMs ?? 2_000;
  const now = opts.now ?? (() => new Date());

  const doors = new Map<string, ResolvedDoor>();
  for (const config of opts.doors) {
    if (!isValidDoorId(config.id)) throw new Error(`kagi: door id "${config.id}" must be 1-64 letters, digits, ".", "_" or "-" (not "." or "..")`);
    if (doors.has(config.id)) throw new Error(`kagi: duplicate door id "${config.id}"`);
    const driver = opts.drivers[config.driver];
    if (!driver) throw new Error(`kagi: door "${config.id}" uses unknown driver "${config.driver}"`);
    let device: unknown;
    try {
      device = driver.parseDevice(config.device);
    } catch (err) {
      throw new Error(`kagi: door "${config.id}" has an invalid device: ${(err as Error).message}`);
    }
    doors.set(config.id, { config, driver, device });
  }

  // principalId + doorId -> epoch ms when the cooldown ends (after a success or a failure)
  const cooldowns = new Map<string, number>();
  // principalId + doorId currently being unlocked
  const inFlight = new Set<string>();

  function cooldownLeft(key: string): number {
    const t = now().getTime();
    for (const [k, until] of cooldowns) if (until <= t) cooldowns.delete(k);
    const until = cooldowns.get(key);
    return until === undefined ? 0 : until - t;
  }

  const log = (msg: string, fields: Record<string, unknown>) => console.error(JSON.stringify({ msg, ...fields }));

  /**
   * Re-reads the state until it reads "unlocked" or "jammed", or the verify window ends.
   * Returns the last fresh state that could be read ("unknown" if none could). A reading the vendor
   * observed before the command was sent (minus clock skew) is stale and does not count.
   */
  async function readBack(door: ResolvedDoor, ctx: Omit<CommandContext, "signal">, sentAt: number): Promise<LockState> {
    const getState = door.driver.getState;
    if (!door.driver.capabilities.readState || !getState) return "unknown";
    const deadline = Date.now() + verify.timeoutMs;
    let last: LockState = "unknown";
    let stale = 0;
    while (Date.now() < deadline) {
      await sleep(Math.min(verify.intervalMs, Math.max(0, deadline - Date.now())));
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const raw = await withTimeout(
        (signal) => getState.call(door.driver, door.device, { ...ctx, signal }),
        Math.min(commandTimeoutMs, remaining),
      ).catch((err: unknown) => {
        // Kept out of the outcome, but logged: it explains a verified=false (quota, bad key, …).
        log("kagi: reading lock state failed", { requestId: ctx.requestId, error: err instanceof Error ? err.message : String(err) });
        return "unknown" as const;
      });
      if (raw === TIMED_OUT) {
        log("kagi: reading lock state timed out", { requestId: ctx.requestId });
        continue;
      }
      const reading: LockReading = typeof raw === "string" ? { state: raw } : raw;
      if (reading.observedAt && reading.observedAt.getTime() < sentAt - verify.clockSkewMs) {
        stale++;
        continue;
      }
      if (reading.state === "unknown") continue;
      last = reading.state;
      if (last === "unlocked" || last === "jammed") return last;
    }
    if (last === "unknown" && stale > 0) log("kagi: lock state readings were older than the command", { requestId: ctx.requestId, stale });
    return last;
  }

  return {
    door(id) {
      return doors.get(id)?.config;
    },

    async unlock({ principal, doorId, requestId = crypto.randomUUID() }): Promise<UnlockOutcome> {
      const door = doors.get(doorId);
      if (!door) return { status: "unknown_door" };

      const base = { requestId, principalId: principal.id, doorId, ...(principal.via && { via: principal.via }) };
      const decision = await opts.authorizer
        .authorize({ principal, door: door.config, now: now() })
        .catch((err: unknown) => {
          console.error("kagi: authorizer failed", err);
          return { allow: false, reason: "authorization_error" } as const;
        });
      if (!decision.allow) {
        await recordSafely(audit, { type: "unlock.denied", at: now(), ...base, reason: decision.reason });
        return { status: "denied", reason: decision.reason };
      }

      // Checked after authorization, so denied users cannot probe them. A double tap never sends
      // two commands: the second is "busy" while the first runs, then waits out a cooldown
      // (longer after a success, short after a failure so repeated presses do not burn quota).
      const key = JSON.stringify([principal.id, doorId]);
      if (inFlight.has(key)) return { status: "busy" };
      const retryAfterMs = cooldownLeft(key);
      if (retryAfterMs > 0) return { status: "cooldown", retryAfterMs };

      inFlight.add(key);
      try {
        const outcome = await run(door, principal, requestId, base);
        const wait = outcome.status === "unlocked" ? cooldownMs : outcome.status === "failed" ? failureCooldownMs : 0;
        if (wait > 0) cooldowns.set(key, now().getTime() + wait);
        return outcome;
      } finally {
        inFlight.delete(key);
      }
    },
  };

  async function run(door: ResolvedDoor, principal: Principal, requestId: string, base: Omit<Parameters<typeof recordSafely>[1], "type" | "at">): Promise<UnlockOutcome> {
    const started = Date.now();
    const sentAt = now().getTime();
    const ctx = { actor: { id: principal.id, displayName: principal.displayName }, requestId };
    const result: CommandResult | typeof TIMED_OUT = await withTimeout(
      (signal) => door.driver.unlock(door.device, { ...ctx, signal }),
      commandTimeoutMs,
    ).catch(
      (err: unknown): Failure => ({ ok: false, reason: "vendor_error", retryable: true, ambiguous: true, detail: err instanceof Error ? err.message : String(err) }),
    );

    const failed = async (reason: CommandFailureReason, retryable: boolean, detail?: string, uncertain?: boolean): Promise<UnlockOutcome> => {
      await recordSafely(audit, { type: "unlock.failed", at: now(), ...base, reason, ...(detail !== undefined && { detail }) });
      return { status: "failed", reason, retryable, ...(uncertain && { uncertain }) };
    };
    const succeeded = async (verified: boolean, detail?: string): Promise<UnlockOutcome> => {
      await recordSafely(audit, { type: "unlock.succeeded", at: now(), ...base, verified, durationMs: Date.now() - started, ...(detail !== undefined && { detail }) });
      return { status: "unlocked", verified };
    };

    const failure: Failure | null = result === TIMED_OUT ? { ok: false, reason: "timeout", retryable: true, ambiguous: true } : result.ok ? null : result;

    // The vendor clearly answered no (4xx, an error code): nothing was done; report it as is.
    if (failure && !failure.ambiguous) return failed(failure.reason, failure.retryable, failure.detail);

    // Accepted, or no clear answer (timeout, network error, 5xx): the command may have reached the
    // lock. Read the state back before saying anything.
    const state = await readBack(door, ctx, sentAt);
    // Includes "was already open". Keep the unclear failure that preceded it in the audit trail.
    if (state === "unlocked") return succeeded(true, failure ? (failure.detail ?? failure.reason) : undefined);
    if (state === "jammed") return failed("jammed", false, failure?.detail);
    if (failure) {
      // Reads locked: nothing happened, safe to try again. Unreadable: the door may be open.
      return state === "locked" ? failed(failure.reason, true, failure.detail) : failed(failure.reason, false, failure.detail, true);
    }
    if (state === "locked") return failed("not_confirmed", true);
    return succeeded(false);
  }
}

/** Runs fn with an AbortSignal that fires after ms; resolves TIMED_OUT even if fn ignores it. */
async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException("kagi command timed out", "TimeoutError"));
      resolve(TIMED_OUT);
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
