import type { CommandResult } from "./types.ts";

/** Maps an exception thrown by fetch() into a CommandResult. Shared by HTTP-based drivers. */
export function abortReason(err: unknown): Extract<CommandResult, { ok: false }> {
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return { ok: false, reason: "timeout", retryable: true };
  }
  return { ok: false, reason: "vendor_error", retryable: true, detail: err instanceof Error ? err.message : String(err) };
}
