import type { AuditEvent, AuditSink } from "./types.ts";

/** One JSON object per line on stdout; picked up as-is by Cloud Logging, Fly, Vercel, etc. */
export function stdoutAuditSink(write: (line: string) => void = (l) => console.log(l)): AuditSink {
  return {
    record(event: AuditEvent) {
      write(JSON.stringify({ ...event, at: event.at.toISOString() }));
    },
  };
}

/** Records an event without letting a failing sink break the unlock path. */
export async function recordSafely(sink: AuditSink, event: AuditEvent): Promise<void> {
  try {
    await sink.record(event);
  } catch (err) {
    console.error("kagi: audit sink failed", err);
  }
}
