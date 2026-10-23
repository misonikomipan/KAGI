// ---- Doors -----------------------------------------------------------------

/** Static configuration. Loaded at startup; no database. */
export interface DoorConfig {
  /** URL segment: /d/<id>. */
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
  | "vendor_error";

export type CommandResult =
  | { ok: true }
  | { ok: false; reason: CommandFailureReason; retryable: boolean; detail?: string };

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
  /** Throws when the state cannot be read. */
  getState?(device: Device, ctx: CommandContext): Promise<LockState>;
}

// ---- Identity --------------------------------------------------------------

export interface Principal {
  /** Stable id from the identity provider. */
  id: string;
  displayName: string;
  /** Provider-specific claims used by authorizers (e.g. Clerk publicMetadata, org roles). */
  claims: Record<string, unknown>;
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
}

export type AuditEvent =
  | (AuditBase & { type: "unlock.denied"; reason: string })
  | (AuditBase & { type: "unlock.failed"; reason: CommandFailureReason; detail?: string })
  | (AuditBase & { type: "unlock.succeeded"; verified: boolean; durationMs: number });

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
  /** Default { timeoutMs: 8_000, intervalMs: 1_000 }. Only used when the driver can read state. */
  verify?: { timeoutMs: number; intervalMs: number };
  /** Per principal+door, in-memory. Default 5_000. */
  cooldownMs?: number;
  now?: () => Date;
}

export type UnlockOutcome =
  /** verified=false: the command was accepted but the state could not be confirmed. */
  | { status: "unlocked"; verified: boolean }
  | { status: "denied"; reason: string }
  | { status: "failed"; reason: CommandFailureReason; retryable: boolean }
  | { status: "cooldown"; retryAfterMs: number }
  | { status: "unknown_door" };

export interface Gate {
  door(id: string): DoorConfig | undefined;
  unlock(input: { principal: Principal; doorId: string; requestId?: string }): Promise<UnlockOutcome>;
}
