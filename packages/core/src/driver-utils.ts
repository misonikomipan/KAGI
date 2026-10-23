import type { CommandResult } from "./types.ts";

/**
 * Maps an exception thrown by fetch() into a CommandResult. Shared by HTTP-based drivers.
 * Always ambiguous: the request may have reached the vendor before the connection failed.
 */
export function abortReason(err: unknown): Extract<CommandResult, { ok: false }> {
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return { ok: false, reason: "timeout", retryable: true, ambiguous: true };
  }
  return { ok: false, reason: "vendor_error", retryable: true, ambiguous: true, detail: err instanceof Error ? err.message : String(err) };
}
