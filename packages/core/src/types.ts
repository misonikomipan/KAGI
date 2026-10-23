// ---- Doors -----------------------------------------------------------------

/** Static configuration. Loaded at startup; no database. */
export interface DoorConfig {
  /** URL segment: /d/<id>. Letters, digits, ".", "_", "-" (not "." or ".."), at most 64. See isValidDoorId(). */
  id: string;
  /** Shown on the button page. */
  name: string;
  /** Key into the drivers map passed to createGate(). */
  driver: string;
  /** Driver-specific device reference, validated by LockDriver.parseDevice(). */
  device: unknown;
}

// ---- Lock drivers ----------------------------------------------------------

export type LockState = "locked" | "unlocked" | "jammed" | "unknown";

export interface LockDriverCapabilities {
  /** getState() is implemented and reflects the physical lock. */
  readState: boolean;
  /** CommandContext.actor.displayName is recorded in the vendor's own history (e.g. SESAME). */
  vendorHistoryLabel: boolean;
}

export interface CommandContext {
  actor: { id: string; displayName: string };
  requestId: string;
  /** The core enforces timeouts through this signal. */
  signal: AbortSignal;
}

export type CommandFailureReason =
  /** Lock or hub unreachable. */
  | "device_offline"
  | "jammed"
  /** Bad credentials, signature or clock skew. */
  | "unauthorized"
  | "rate_limited"
  | "timeout"
  /** Config points at a non-lock or unknown device. */
  | "invalid_device"
  | "vendor_error"
  /** Set by the core, never by drivers: the lock still read "locked" after the unlock command. */
  | "not_confirmed";

export type CommandResult =
  | { ok: true }
  | {
      ok: false;
      reason: CommandFailureReason;
      retryable: boolean;
      detail?: string;
      /**
       * No clear answer from the vendor (network error, timeout, HTTP 5xx): the command may still
       * have been carried out, so the core reads the state back before reporting. Leave unset when
       * the vendor clearly refused (4xx, an error code in the body).
       */
      ambiguous?: boolean;
    };

/** A state reading with, when the vendor reports it, the time the vendor last observed it. */
export interface LockReading {
  state: LockState;
  /** Lets the core ignore a cached value older than the command (e.g. SESAME's shadow timestamp). */
  observedAt?: Date;
}

/**
 * One vendor (or one vendor account). Drivers translate vendor quirks into LockState and
 * CommandResult; they do not retry, poll or verify — the core does.
 */
export interface LockDriver<Device = unknown> {
  /** "switchbot" | "sesame" | … */
  readonly kind: string;
  readonly capabilities: LockDriverCapabilities;
  /** Validate DoorConfig.device at startup. Throw with a readable message if invalid. */
  parseDevice(device: unknown): Device;
  unlock(device: Device, ctx: CommandContext): Promise<CommandResult>;
  lock?(device: Device, ctx: CommandContext): Promise<CommandResult>;
  /** Throws when the state cannot be read. Return a LockReading when the vendor says how fresh it is. */
  getState?(device: Device, ctx: CommandContext): Promise<LockState | LockReading>;
}

// ---- Identity --------------------------------------------------------------

export interface Principal {
  /** Stable id from the identity provider. */
  id: string;
  displayName: string;
  /** Provider-specific claims used by authorizers (e.g. Clerk publicMetadata, org roles). */
  claims: Record<string, unknown>;
  /**
   * Which entry point the request came through, set by the HTTP adapter (never by the identity
   * provider): "web" for the door page, "api" for the API. Lets authorizers apply different rules.
   */
  via?: "web" | "api";
}

/**
 * Either a signed-in principal, or a response the browser must follow first: a sign-in page
 * that returns to `returnTo`, or a provider round-trip such as Clerk's session handshake.
 */
export type AuthResult = { ok: true; principal: Principal } | { ok: false; response: Response };

/** Identity integration for the HTTP adapter (OIDC by default). Framework-agnostic. */
export interface Authenticator {
  authenticate(req: Request, opts: { returnTo: string }): Promise<AuthResult>;
  /**
   * Endpoints the integration owns under /auth/ (e.g. the OIDC callback, logout).
   * Return null for paths it does not handle.
   */
  handle?(req: Request): Promise<Response | null>;
  /** If set, the door page offers a sign-out button that POSTs here (handled by `handle`). */
  readonly logoutPath?: string;
}

// ---- Presence (optional) ---------------------------------------------------

/**
 * Proves the request comes from a physical tap on this door's tag, not a remembered URL.
 * Default: none (static URL). Planned: NTAG 424 DNA SUN (per-tap CMAC + monotonic counter).
 */
export interface PresenceVerifier {
  verify(input: { doorId: string; url: URL }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

// ---- Authorization ---------------------------------------------------------

export interface AuthorizationInput {
  principal: Principal;
  door: DoorConfig;
  now: Date;
}

/** `reason` is for logs and the denial page; it must not leak secrets. */
export type Decision = { allow: true } | { allow: false; reason: string };

export interface Authorizer {
  authorize(input: AuthorizationInput): Promise<Decision>;
}

// ---- Audit -----------------------------------------------------------------

interface AuditBase {
  at: Date;
  requestId: string;
  principalId: string;
  doorId: string;
  /** Entry point (door page or API), when the HTTP adapter set Principal.via. */
  via?: "web" | "api";
}

export type AuditEvent =
  | (AuditBase & { type: "unlock.denied"; reason: string })
  | (AuditBase & { type: "unlock.failed"; reason: CommandFailureReason; detail?: string })
  /** detail: the unclear failure (timeout, network error) that preceded a read-back of "unlocked". */
  | (AuditBase & { type: "unlock.succeeded"; verified: boolean; durationMs: number; detail?: string });

export interface AuditSink {
  /** Must not throw into the unlock path; the core also guards against it. */
  record(event: AuditEvent): void | Promise<void>;
}

// ---- Gate ------------------------------------------------------------------

export interface GateOptions {
  doors: DoorConfig[];
  drivers: Record<string, LockDriver>;
  authorizer: Authorizer;
  /** Default: JSON lines to stdout. */
  audit?: AuditSink;
  /** Default 10_000. */
  commandTimeoutMs?: number;
  /**
   * Default { timeoutMs: 8_000, intervalMs: 1_000, clockSkewMs: 2_000 }. Only used when the driver
   * can read state. Readings observed more than clockSkewMs before the command was sent are stale.
   */
  verify?: { timeoutMs: number; intervalMs: number; clockSkewMs?: number };
  /**
   * Per principal+door, in-memory, started after a successful unlock. Default 5_000. A second
   * press while the first is still running is always rejected (status "busy").
   */
  cooldownMs?: number;
  /** Like cooldownMs, after a failure, so repeated presses do not burn the vendor's quota. Default 2_000. */
  failureCooldownMs?: number;
  now?: () => Date;
}

export type UnlockOutcome =
  /**
   * verified=true: the lock read "unlocked" after the command. verified=false: the command was
   * accepted but the state could not be read (driver cannot read state, or reads kept failing).
   * A lock that reads "locked" afterwards is a failure ("not_confirmed"), never "unlocked".
   */
  | { status: "unlocked"; verified: boolean }
  | { status: "denied"; reason: string }
  /**
   * uncertain=true: no clear answer and the state could not be read, so the door may already be
   * open; the person should check before pressing again (retryable is then false).
   */
  | { status: "failed"; reason: CommandFailureReason; retryable: boolean; uncertain?: boolean }
  /** Pressed again within the cooldown after a success or a failure. */
  | { status: "cooldown"; retryAfterMs: number }
  /** Pressed again while the previous press for the same door is still running. */
  | { status: "busy" }
  | { status: "unknown_door" };

export interface Gate {
  door(id: string): DoorConfig | undefined;
  unlock(input: { principal: Principal; doorId: string; requestId?: string }): Promise<UnlockOutcome>;
}

/** Door ids are URL segments written on NFC tags: plain ASCII, no "." / ".." path segments. */
export function isValidDoorId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(id) && !/^\.+$/.test(id);
}
