import type { AuthorizationInput, Authorizer, Decision } from "./types.ts";

const ALLOW: Decision = { allow: true };

/** Allow only when every authorizer allows. Evaluated in order; the first denial wins. */
export function allOf(...authorizers: Authorizer[]): Authorizer {
  if (authorizers.length === 0) throw new Error("kagi: allOf() needs at least one authorizer");
  return {
    async authorize(input) {
      for (const a of authorizers) {
        const d = await a.authorize(input);
        if (!d.allow) return d;
      }
      return ALLOW;
    },
  };
}

/** Allow when any authorizer allows. Denial reasons are joined for the log. */
export function anyOf(...authorizers: Authorizer[]): Authorizer {
  if (authorizers.length === 0) throw new Error("kagi: anyOf() needs at least one authorizer");
  return {
    async authorize(input) {
      const reasons: string[] = [];
      for (const a of authorizers) {
        const d = await a.authorize(input);
        if (d.allow) return d;
        reasons.push(d.reason);
      }
      return { allow: false, reason: reasons.join("; ") };
    },
  };
}

/**
 * Allow when the claim at `path` (dot-separated, e.g. "groups" or "publicMetadata.doors") is a
 * string array containing `${prefix}${door.id}` or `${prefix}*`.
 *
 *   claimAllowList("doors")                        // ["home", "office"]
 *   claimAllowList("groups", { prefix: "door:" })  // ["staff", "door:office"]
 */
export function claimAllowList(path: string, opts: { prefix?: string } = {}): Authorizer {
  const keys = path.split(".");
  const prefix = opts.prefix ?? "";
  return {
    async authorize({ principal, door }) {
      let value: unknown = principal.claims;
      for (const k of keys) {
        value = value !== null && typeof value === "object" ? (value as Record<string, unknown>)[k] : undefined;
      }
      if (Array.isArray(value) && (value.includes(prefix + door.id) || value.includes(`${prefix}*`))) return ALLOW;
      return { allow: false, reason: `door not in claim ${path}` };
    },
  };
}

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export interface WeeklyWindow {
  days: Weekday[];
  /** "HH:MM", inclusive. */
  start: string;
  /** "HH:MM", exclusive. If not after `start`, the window runs past midnight into the next day. */
  end: string;
}

const WEEKDAYS: Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Allow only within weekly windows, evaluated in the given IANA time zone. */
export function timeWindow(opts: { timeZone: string; windows: WeeklyWindow[] }): Authorizer {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: opts.timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const windows = opts.windows.map((w) => ({ days: w.days, start: parseHHMM(w.start), end: parseHHMM(w.end) }));

  return {
    async authorize({ now }: AuthorizationInput) {
      const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
      const day = WEEKDAYS.indexOf(String(parts.weekday).toLowerCase() as Weekday);
      const minute = Number(parts.hour) * 60 + Number(parts.minute);
      const yesterday = WEEKDAYS[(day + 6) % 7] as Weekday;
      const today = WEEKDAYS[day] as Weekday;

      for (const w of windows) {
        if (w.start < w.end) {
          if (w.days.includes(today) && minute >= w.start && minute < w.end) return ALLOW;
        } else {
          // Overnight window, e.g. 22:00-06:00: the tail belongs to the previous day's window.
          if (w.days.includes(today) && minute >= w.start) return ALLOW;
          if (w.days.includes(yesterday) && minute < w.end) return ALLOW;
        }
      }
      return { allow: false, reason: "outside allowed hours" };
    },
  };
}

function parseHHMM(s: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) throw new Error(`kagi: invalid time "${s}", expected HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Delegate to an external HTTP endpoint (e.g. an HR or shift system). KAGI POSTs
 * `{ principal, door: { id, name }, now }` and expects `{ allow: boolean, reason?: string }`.
 * Any error, timeout or malformed response denies (fail closed).
 */
export function httpAuthorizer(opts: {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): Authorizer {
  const doFetch = opts.fetch ?? fetch;
  return {
    async authorize({ principal, door, now }) {
      try {
        const res = await doFetch(opts.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...opts.headers },
          body: JSON.stringify({ principal, door: { id: door.id, name: door.name }, now: now.toISOString() }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 3_000),
        });
        if (!res.ok) return { allow: false, reason: `authorizer endpoint returned HTTP ${res.status}` };
        const body = (await res.json()) as { allow?: unknown; reason?: unknown };
        if (body.allow === true) return ALLOW;
        return { allow: false, reason: typeof body.reason === "string" ? body.reason : "denied by authorizer endpoint" };
      } catch {
        return { allow: false, reason: "authorizer endpoint unavailable" };
      }
    },
  };
}
