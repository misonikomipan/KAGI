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
          history: Buffer.from(label(ctx), "utf8").toString("base64"),
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
      return normalizeLockState((JSON.parse(text) as { CHSesame2Status?: unknown }).CHSesame2Status);
    },
  };
}

/**
 * sign = hex(AES-CMAC(secretKey, ts[1..4])) where ts is the Unix time in seconds as a
 * little-endian uint32. The official docs word this as "remove the most-significant byte", but
 * the published Python/PHP clients drop byte 0 of the LE buffer (the least-significant byte);
 * we follow the clients. Verify against a real device before trusting this comment.
 */
export function sign(secretKeyHex: string, unixSeconds: number): string {
  const ts = Buffer.alloc(4);
  ts.writeUInt32LE(unixSeconds >>> 0);
  return aesCmac(Buffer.from(secretKeyHex, "hex"), ts.subarray(1, 4)).toString("hex");
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
  return { ok: false, reason: "vendor_error", retryable: http >= 500, detail };
}
