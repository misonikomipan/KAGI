import { recordSafely, stdoutAuditSink } from "./audit.ts";
import type {
  CommandContext,
  CommandResult,
  DoorConfig,
  Gate,
  GateOptions,
  LockDriver,
  LockState,
  Principal,
  UnlockOutcome,
} from "./types.ts";

interface ResolvedDoor {
  config: DoorConfig;
  driver: LockDriver;
  device: unknown;
}

const TIMED_OUT = Symbol("timed out");

/**
 * Builds the orchestrator. Validates every door against its driver up front, so a typo in the
 * configuration fails at startup rather than at the door.
 */
export function createGate(opts: GateOptions): Gate {
  const audit = opts.audit ?? stdoutAuditSink();
  const commandTimeoutMs = opts.commandTimeoutMs ?? 10_000;
  const verify = opts.verify ?? { timeoutMs: 8_000, intervalMs: 1_000 };
  const cooldownMs = opts.cooldownMs ?? 5_000;
  const now = opts.now ?? (() => new Date());

  const doors = new Map<string, ResolvedDoor>();
  for (const config of opts.doors) {
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

  // principalId + doorId -> epoch ms when the cooldown ends
  const cooldowns = new Map<string, number>();

  function takeCooldown(principal: Principal, doorId: string): number {
    const key = JSON.stringify([principal.id, doorId]);
    const t = now().getTime();
    for (const [k, until] of cooldowns) if (until <= t) cooldowns.delete(k);
    const until = cooldowns.get(key);
    if (until !== undefined) return until - t;
    cooldowns.set(key, t + cooldownMs);
    return 0;
  }

  async function verifyUnlocked(door: ResolvedDoor, ctx: Omit<CommandContext, "signal">): Promise<LockState> {
    const getState = door.driver.getState;
    if (!door.driver.capabilities.readState || !getState) return "unknown";
    const deadline = Date.now() + verify.timeoutMs;
    let last: LockState = "unknown";
    while (Date.now() < deadline) {
      await sleep(Math.min(verify.intervalMs, Math.max(0, deadline - Date.now())));
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const state = await withTimeout(
        (signal) => getState.call(door.driver, door.device, { ...ctx, signal }),
        Math.min(commandTimeoutMs, remaining),
      ).catch(() => "unknown" as const);
      if (state === TIMED_OUT) continue;
      last = state;
      if (state === "unlocked" || state === "jammed") return state;
    }
    return last;
  }

  return {
    door(id) {
      return doors.get(id)?.config;
    },

    async unlock({ principal, doorId, requestId = crypto.randomUUID() }): Promise<UnlockOutcome> {
      const door = doors.get(doorId);
      if (!door) return { status: "unknown_door" };

      const base = { requestId, principalId: principal.id, doorId };
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

      // Cooldown after authorization, so denied users cannot probe it and a double tap
      // never sends two commands.
      const retryAfterMs = takeCooldown(principal, doorId);
      if (retryAfterMs > 0) return { status: "cooldown", retryAfterMs };

      const started = Date.now();
      const ctx = { actor: { id: principal.id, displayName: principal.displayName }, requestId };
      const result: CommandResult | typeof TIMED_OUT = await withTimeout(
        (signal) => door.driver.unlock(door.device, { ...ctx, signal }),
        commandTimeoutMs,
      ).catch((err: unknown) => ({
        ok: false as const,
        reason: "vendor_error" as const,
        retryable: true,
        detail: err instanceof Error ? err.message : String(err),
      }));

      const failure =
        result === TIMED_OUT
          ? { ok: false as const, reason: "timeout" as const, retryable: true }
          : result.ok
            ? null
            : result;
      if (failure) {
        await recordSafely(audit, {
          type: "unlock.failed",
          at: now(),
          ...base,
          reason: failure.reason,
          ...(failure.detail !== undefined && { detail: failure.detail }),
        });
        return { status: "failed", reason: failure.reason, retryable: failure.retryable };
      }

      const state = await verifyUnlocked(door, ctx);
      if (state === "jammed") {
        await recordSafely(audit, { type: "unlock.failed", at: now(), ...base, reason: "jammed" });
        return { status: "failed", reason: "jammed", retryable: false };
      }
      const verified = state === "unlocked";
      await recordSafely(audit, {
        type: "unlock.succeeded",
        at: now(),
        ...base,
        verified,
        durationMs: Date.now() - started,
      });
      return { status: "unlocked", verified };
    },
  };
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
