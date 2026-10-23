import { abortReason, type CommandContext, type CommandResult, type LockDriver, type LockState } from "@kagi/core";
import { aesCmac } from "./cmac.ts";

// SESAME Web API (SESAME 3/4/5 via Hub3 or Wi-Fi Module 2): https://doc.candyhouse.co/ja/SesameAPI

export interface SesameOptions {
  /** API key from the CANDY HOUSE developer portal. Sent as x-api-key. */
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Name shown in the SESAME app history. Default: the actor's display name. */
  historyLabel?: (ctx: CommandContext) => string;
  /** Seconds since epoch; injectable for tests. */
  nowSeconds?: () => number;
}

export interface SesameDevice {
  /** Device UUID shown in the SESAME app. */
  uuid: string;
  /** The device's secret key: 16 bytes as 32 hex chars. Used to sign commands. */
  secretKey: string;
}

const CMD = { lock: 82, unlock: 83 } as const;

export function sesameDriver(opts: SesameOptions): LockDriver<SesameDevice> {
  if (!opts.apiKey) throw new Error("sesame: apiKey is required");
  const baseUrl = opts.baseUrl ?? "https://app.candyhouse.co/api/sesame2";
  const doFetch = opts.fetch ?? fetch;
  const label = opts.historyLabel ?? ((ctx) => ctx.actor.displayName);
  const nowSeconds = opts.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  async function command(device: SesameDevice, cmd: keyof typeof CMD, ctx: CommandContext): Promise<CommandResult> {
    try {
      const res = await doFetch(`${baseUrl}/${device.uuid}/cmd`, {
        method: "POST",
        headers: { "x-api-key": opts.apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          cmd: CMD[cmd],
          history: historyTag(label(ctx)),
          sign: sign(device.secretKey, nowSeconds()),
        }),
        signal: ctx.signal,
      });
      return toResult(res.status, await res.text());
    } catch (err) {
      return abortReason(err);
    }
  }

  return {
    kind: "sesame",
    capabilities: { readState: true, vendorHistoryLabel: true },

    parseDevice(device) {
      const d = device as Partial<Record<keyof SesameDevice, unknown>> | null;
      if (typeof d?.uuid !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(d.uuid)) {
        throw new Error('expected { uuid: "<SESAME UUID>", secretKey: "<32 hex chars>" }');
      }
      if (typeof d.secretKey !== "string" || !/^[0-9a-f]{32}$/i.test(d.secretKey)) {
        throw new Error("secretKey must be 32 hex chars (16 bytes)");
      }
      return { uuid: d.uuid, secretKey: d.secretKey.toLowerCase() };
    },

    unlock: (device, ctx) => command(device, "unlock", ctx),
    lock: (device, ctx) => command(device, "lock", ctx),

    async getState(device, ctx) {
      const res = await doFetch(`${baseUrl}/${device.uuid}`, {
        headers: { "x-api-key": opts.apiKey },
        signal: ctx.signal,
      });
      const text = await res.text();
      const r = toResult(res.status, text);
      if (!r.ok) throw new Error(`sesame: ${r.reason}${r.detail ? ` (${r.detail})` : ""}`);
      const body = JSON.parse(text) as { CHSesame2Status?: unknown; timestamp?: unknown };
      // The status is the cloud's cached shadow; its timestamp lets the core skip stale values.
      const observedAt = shadowTime(body.timestamp);
      return { state: normalizeLockState(body.CHSesame2Status), ...(observedAt && { observedAt }) };
    },
  };
}

/**
 * sign = hex(AES-CMAC(secretKey, ts[1..4])) where ts is the Unix time in seconds as a
 * little-endian uint32. The official docs word this as "remove the most-significant byte", but
 * their own sample code drops byte 0 of the LE buffer (`slice(1, 4)`); so do we.
 */
export function sign(secretKeyHex: string, unixSeconds: number): string {
  const ts = Buffer.alloc(4);
  ts.writeUInt32LE(unixSeconds >>> 0);
  return aesCmac(Buffer.from(secretKeyHex, "hex"), ts.subarray(1, 4)).toString("hex");
}

/** The history tag holds at most 21 bytes; truncate on a character boundary, then base64. */
export function historyTag(label: string): string {
  let out = "";
  for (const ch of label) {
    if (Buffer.byteLength(out + ch, "utf8") > 21) break;
    out += ch;
  }
  return Buffer.from(out, "utf8").toString("base64");
}

export interface SesameHistoryEntry {
  /** 2 bleUnLock, 8 manualUnlocked, 11 driveUnlocked, 12 driveFailed, 15 wm2Unlock, 17 webUnlock, … */
  type: number;
  timeStamp: number;
  /** Decoded historyTag (the label sent with the command), if any. */
  tag: string | null;
  recordID: number;
}

/** Latest history entries, newest first. Not part of LockDriver; used by `bun run probe`. */
export async function fetchHistory(
  opts: Pick<SesameOptions, "apiKey" | "baseUrl" | "fetch">,
  uuid: string,
  count = 10,
): Promise<SesameHistoryEntry[]> {
  const baseUrl = opts.baseUrl ?? "https://app.candyhouse.co/api/sesame2";
  const res = await (opts.fetch ?? fetch)(`${baseUrl}/${uuid}/history?page=0&lg=${count}`, {
    headers: { "x-api-key": opts.apiKey },
  });
  if (!res.ok) throw new Error(`sesame: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const rows = (await res.json()) as Array<{ type: number; timeStamp: number; historyTag: string | null; recordID: number }>;
  return rows.map((r) => ({
    type: r.type,
    timeStamp: r.timeStamp,
    tag: r.historyTag ? Buffer.from(r.historyTag, "base64").toString("utf8") : null,
    recordID: r.recordID,
  }));
}

/** CHSesame2Status: "locked" | "unlocked" | "moved" (thumb turn between positions). */
export function normalizeLockState(value: unknown): LockState {
  if (value === "locked") return "locked";
  if (value === "unlocked") return "unlocked";
  return "unknown";
}

function toResult(http: number, body: string): CommandResult {
  if (http >= 200 && http < 300) return { ok: true };
  const detail = `HTTP ${http}${body ? `: ${body.slice(0, 200)}` : ""}`;
  if (http === 401 || http === 403) return { ok: false, reason: "unauthorized", retryable: false, detail };
  if (http === 404) return { ok: false, reason: "invalid_device", retryable: false, detail };
  if (http === 429) return { ok: false, reason: "rate_limited", retryable: true, detail };
  // 5xx: no clear answer, the command may still have run. Other 4xx (e.g. a bad signature): refused.
  if (http >= 500) return { ok: false, reason: "vendor_error", retryable: true, ambiguous: true, detail };
  return { ok: false, reason: "vendor_error", retryable: false, detail };
}

/**
 * The status `timestamp` is when the Sesame shadow was last updated. The docs call it milliseconds,
 * their example is seconds (1598523693): treat values below 1e12 as seconds.
 */
export function shadowTime(value: unknown): Date | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value < 1e12 ? value * 1000 : value);
}
