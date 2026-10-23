import { createHmac, randomUUID } from "node:crypto";
import { abortReason, type CommandContext, type CommandResult, type LockDriver, type LockState } from "@kagi/core";

// SwitchBot OpenAPI v1.1: https://github.com/OpenWonderLabs/SwitchBotAPI

export interface SwitchBotOptions {
  /** "Token" from the SwitchBot app (Profile > Preferences > Developer Options). */
  token: string;
  /** "Secret key" from the same screen. */
  secret: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface SwitchBotDevice {
  deviceId: string;
}

interface Envelope<T = unknown> {
  statusCode: number;
  message: string;
  body: T;
}

/** Thin signed client. Exposed for tooling such as `bun run probe switchbot devices`. */
export class SwitchBotClient {
  readonly #token: string;
  readonly #secret: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(opts: SwitchBotOptions) {
    if (!opts.token || !opts.secret) throw new Error("switchbot: token and secret are required");
    this.#token = opts.token;
    this.#secret = opts.secret;
    this.#baseUrl = opts.baseUrl ?? "https://api.switch-bot.com";
    this.#fetch = opts.fetch ?? fetch;
  }

  /** Signature: base64(HMAC-SHA256(secret, token + t + nonce)). */
  headers(t = Date.now(), nonce: string = randomUUID()): Record<string, string> {
    const sign = createHmac("sha256", this.#secret).update(`${this.#token}${t}${nonce}`).digest("base64");
    return { authorization: this.#token, sign, t: String(t), nonce, "content-type": "application/json; charset=utf8" };
  }

  async request<T>(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<{ http: number; envelope?: Envelope<T> }> {
    const res = await this.#fetch(`${this.#baseUrl}/v1.1${path}`, {
      method,
      headers: this.headers(),
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(signal && { signal }),
    });
    const text = await res.text();
    let envelope: Envelope<T> | undefined;
    try {
      envelope = JSON.parse(text) as Envelope<T>;
    } catch {
      envelope = undefined;
    }
    return { http: res.status, ...(envelope && { envelope }) };
  }

  async listDevices(): Promise<Envelope<{ deviceList: Array<Record<string, unknown>> }>> {
    const { http, envelope } = await this.request<{ deviceList: Array<Record<string, unknown>> }>("GET", "/devices");
    if (!envelope) throw new Error(`switchbot: HTTP ${http}`);
    return envelope;
  }
}

export function switchbotDriver(opts: SwitchBotOptions): LockDriver<SwitchBotDevice> {
  const client = new SwitchBotClient(opts);

  async function command(device: SwitchBotDevice, command: "lock" | "unlock", ctx: CommandContext): Promise<CommandResult> {
    try {
      const { http, envelope } = await client.request(
        "POST",
        `/devices/${encodeURIComponent(device.deviceId)}/commands`,
        { command, parameter: "default", commandType: "command" },
        ctx.signal,
      );
      return toResult(http, envelope);
    } catch (err) {
      return abortReason(err);
    }
  }

  return {
    kind: "switchbot",
    capabilities: { readState: true, vendorHistoryLabel: false },

    parseDevice(device) {
      const id = (device as { deviceId?: unknown } | null)?.deviceId;
      if (typeof id !== "string" || !/^[0-9A-Fa-f]{12}$/.test(id)) {
        throw new Error('expected { deviceId: "<12 hex chars>" } (see `bun run probe switchbot devices`)');
      }
      return { deviceId: id };
    },

    unlock: (device, ctx) => command(device, "unlock", ctx),
    lock: (device, ctx) => command(device, "lock", ctx),

    async getState(device, ctx) {
      const { http, envelope } = await client.request<{ lockState?: unknown }>(
        "GET",
        `/devices/${encodeURIComponent(device.deviceId)}/status`,
        undefined,
        ctx.signal,
      );
      const r = toResult(http, envelope);
      if (!r.ok) throw new Error(`switchbot: ${r.reason}${r.detail ? ` (${r.detail})` : ""}`);
      return normalizeLockState(envelope?.body?.lockState);
    },
  };
}

/**
 * lockState differs by model and doc revision: "lock" / "unlock" / "jammed" (Lock, Lock Pro),
 * plus "latchBoltLocked" (Ultra, Vision, Pro Matter); older docs and webhooks use "LOCKED" etc.
 */
export function normalizeLockState(value: unknown): LockState {
  switch (typeof value === "string" ? value.toLowerCase() : "") {
    case "lock":
    case "locked":
    case "latchboltlocked":
      return "locked";
    case "unlock":
    case "unlocked":
      return "unlocked";
    case "jammed":
      return "jammed";
    default:
      return "unknown";
  }
}

function toResult(http: number, envelope: Envelope | undefined): CommandResult {
  // 401 is also returned when the 10,000 requests/day quota is exhausted.
  if (http === 401) return { ok: false, reason: "unauthorized", retryable: false, detail: "invalid token/secret or daily quota exceeded" };
  if (http === 429) return { ok: false, reason: "rate_limited", retryable: true };
  if (http >= 500) return { ok: false, reason: "vendor_error", retryable: true, detail: `HTTP ${http}` };
  if (!envelope || http !== 200) return { ok: false, reason: "vendor_error", retryable: false, detail: `HTTP ${http}` };

  const detail = `statusCode ${envelope.statusCode}: ${envelope.message}`;
  switch (envelope.statusCode) {
    case 100:
      return { ok: true };
    case 151: // device type error
    case 152: // device not found
    case 160: // command not supported
      return { ok: false, reason: "invalid_device", retryable: false, detail };
    case 161: // device offline
    case 171: // hub offline
      return { ok: false, reason: "device_offline", retryable: true, detail };
    default: // 190: device internal error / states not synchronized
      return { ok: false, reason: "vendor_error", retryable: true, detail };
  }
}
