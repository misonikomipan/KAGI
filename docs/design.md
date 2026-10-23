# KAGI — interface design (draft)

KAGI (Keyless Access Gate Interface) unlocks a door when an authorized person taps an NFC tag
at the entrance, signs in, and presses a button. Smart-lock vendors, identity providers and
authorization policies are all pluggable; the core only orchestrates them.

```
NFC tag at the door ── https://<host>/d/office
        │
        ▼
 ┌──────────── HTTP adapter (thin: one page + one POST) ─────────────┐
 │  Authenticator ── who is this?            (any OIDC provider)      │
 │  PresenceVerifier ── tapped right here?   (optional: NTAG 424 SUN) │
 └──────────────────────────────┬────────────────────────────────────┘
                                ▼
                    Gate (core orchestrator)
                     ├─ Authorizer      ── may this person open this door now?
                     ├─ LockDriver      ── SwitchBot / SESAME / …
                     └─ AuditSink       ── who opened what, when (stdout JSON by default)
```

## Design principles

1. **The NFC tag is never the key.** It only carries a URL. Every decision is made server-side
   from an authenticated principal.
2. **No unlock on GET.** Opening the URL shows a single "Unlock" button; only the POST unlocks.
   Link previews and accidental taps must not open the door.
3. **A command being accepted is not the door being open.** Vendors return 200 while the device
   is offline or the motor is jammed. The core re-reads the state when the driver can, and reports
   `verified` honestly.
4. **No database in the core.** Doors are configuration; allow-lists live in the identity
   provider; the audit trail is a log stream (or the vendor app's history).
5. **Vendor quirks stay inside drivers.** The core only sees `LockState` and `CommandFailure`.

## Tech stack

| Layer | Choice | Why / rejected alternatives |
| --- | --- | --- |
| Language | TypeScript (strict) | Every library involved (Hono, openid-client, jose) is TS-first. |
| Runtime & tooling | Bun (workspaces, `bun test`) | One tool for install/test/run, runs TS without a build step, fast cold start. Node 24 would also work; nothing in the core is Bun-specific (only `node:crypto` and Web APIs). |
| HTTP | Hono + `hono/jsx` (server-rendered, no client JS) | Two pages and one POST don't need React or a bundler; Next.js was rejected as too heavy for that. `hono/csrf` covers the Origin check. |
| Identity | **OpenID Connect** via `openid-client` + `jose` (default); Clerk as an optional adapter | Not tied to one vendor: Pocket ID, Google, Entra ID, Okta, Keycloak and Clerk (as an OIDC provider) all speak OIDC. Both libraries are by the same author, widely used and dependency-free. Other apps call the API with a bearer JWT verified against the issuer's JWKS, so no vendor SDK there either. |
| Lock vendors | Hand-written `fetch` clients | SwitchBot needs HMAC-SHA256, SESAME needs AES-CMAC; both fit in `node:crypto`. No vendor SDKs, so the dependency tree of a door-opening service stays small and auditable. |
| Lint / format | Biome | One fast tool instead of ESLint + Prettier. |
| Hosting | Cloud Run (`asia-northeast1`) | Container, scale to zero, secrets from Secret Manager, stdout JSON lands in Cloud Logging as structured audit logs. |
| Container | `bun build --compile` → distroless image | Single binary, small image, short cold start (someone is standing at the door). |

Cloud Run settings that follow from the design:

- **`max-instances=1`.** The cooldown lives in memory; one instance keeps it consistent without a
  database. Traffic is a handful of requests a day.
- **`min-instances`:** start at 0 and measure the cold start at the door; set 1 if it hurts.
- **Custom domain is required.** The URL written to NFC tags must never change, and the OIDC
  redirect URI is registered against it. Use Cloud Run domain mapping or a load balancer.

## Packages (Bun workspaces)

| Package | Contents |
| --- | --- |
| `@kagi/core` | Types below, `createGate()`, built-in authorizers, stdout audit sink |
| `@kagi/driver-switchbot` | SwitchBot OpenAPI v1.1 (Lock / Lock Pro / Lock Ultra via Hub) |
| `@kagi/driver-sesame` | SESAME Web API (SESAME 5 etc. via Hub3 / Wi-Fi module) |
| `@kagi/auth-oidc` | `oidcAuthenticator` (browser sign-in, own encrypted session cookie) and `jwtBearerAuthenticator` (API) |
| `@kagi/auth-clerk` | Optional `Authenticator` on the Clerk SDK (Account Portal sign-in, instant session revocation) |
| `@kagi/server` | `createKagiApp()`: the Hono app (door page + unlock route), no config loading |
| `apps/server` | Deployable entrypoint: config from env, Dockerfile for Cloud Run |

## Core types

### Doors

```ts
/** Static configuration. Loaded at startup; no database. */
interface DoorConfig {
  id: string;                 // URL segment: /d/<id>; 1-64 of [A-Za-z0-9._-], not "." or ".." (isValidDoorId)
  name: string;               // shown on the button page
  driver: string;             // key into the drivers map passed to createGate()
  device: unknown;            // driver-specific device reference, validated by the driver
}
```

### Lock drivers

```ts
type LockState = "locked" | "unlocked" | "jammed" | "unknown";

interface LockDriverCapabilities {
  /** getState() is implemented and reflects the physical lock. */
  readState: boolean;
  /** CommandContext.actor.displayName is recorded in the vendor's own history (e.g. SESAME). */
  vendorHistoryLabel: boolean;
}

interface CommandContext {
  actor: { id: string; displayName: string };
  requestId: string;
  signal: AbortSignal;        // core enforces timeouts through this
}

type CommandFailureReason =
  | "device_offline"          // lock or hub unreachable
  | "jammed"
  | "unauthorized"            // bad credentials / signature / clock skew
  | "rate_limited"
  | "timeout"
  | "invalid_device"          // config points at a non-lock or unknown device
  | "vendor_error"
  | "not_confirmed";          // set by the core: the lock still read "locked" after the command

type CommandResult =
  | { ok: true }
  | {
      ok: false; reason: CommandFailureReason; retryable: boolean; detail?: string;
      /** No clear answer (network error, timeout, HTTP 5xx): the command may have run. */
      ambiguous?: boolean;
    };

/** A reading plus, when the vendor reports it, when the vendor last observed that state. */
interface LockReading { state: LockState; observedAt?: Date }

interface LockDriver<Device = unknown> {
  readonly kind: string;                          // "switchbot" | "sesame" | …
  readonly capabilities: LockDriverCapabilities;
  /** Validate DoorConfig.device at startup. Throw with a readable message if invalid. */
  parseDevice(device: unknown): Device;
  unlock(device: Device, ctx: CommandContext): Promise<CommandResult>;
  lock?(device: Device, ctx: CommandContext): Promise<CommandResult>;
  /** Throws when the state cannot be read. */
  getState?(device: Device, ctx: CommandContext): Promise<LockState | LockReading>;
}
```

Drivers do **not** retry, poll or verify; the core does (one place to tune timeouts). Drivers do
say how sure they are: `ambiguous` only when the vendor gave no clear answer (fetch errors via
`abortReason()`, 5xx); a clear refusal (4xx, an error code in the body, SwitchBot's 190) is not
ambiguous, and its `retryable` is used as is.

**Freshness of readings.** Vendor clouds answer state reads from a cache. SESAME returns the
shadow's `timestamp` (seconds in the docs' example, "milliseconds" in their text; values below
1e12 are taken as seconds), so its driver returns `observedAt`. The core ignores readings observed
more than `verify.clockSkewMs` (2 s) before the command was sent. SwitchBot's status has no
timestamp: a cached value there cannot be told from a fresh one, which is a known limit.

### Identity

```ts
interface Principal {
  id: string;                               // stable id from the identity provider
  displayName: string;
  /** Provider claims used by authorizers (e.g. OIDC "groups", Clerk publicMetadata). */
  claims: Record<string, unknown>;
  /** Entry point, set by the HTTP adapter (never by the provider): "web" (door page) or "api". */
  via?: "web" | "api";
}

/**
 * Either a signed-in principal, or a response the browser must follow first: a sign-in page
 * that returns to `returnTo`, or a provider round-trip such as Clerk's session handshake.
 */
type AuthResult = { ok: true; principal: Principal } | { ok: false; response: Response };

/** Identity integration for the HTTP adapter (OIDC by default). Framework-agnostic. */
interface Authenticator {
  authenticate(req: Request, opts: { returnTo: string }): Promise<AuthResult>;
  /** Endpoints it owns under /auth/ (OIDC callback, POST logout); null for anything else. */
  handle?(req: Request): Promise<Response | null>;
  /** If set, the door page shows a "Sign out" button that POSTs here. */
  readonly logoutPath?: string;
}
```

The draft had `authenticate(): Principal | null` plus `signInUrl()`. That cannot express a
provider round-trip (OIDC's authorize → callback, Clerk's handshake). Returning a `Response` covers
both. The HTTP adapter follows it on GET, and on POST redirects back to the door page instead
(303), so a POST is never replayed through a redirect chain.

#### OIDC (`@kagi/auth-oidc`, the default)

- **Browser sign-in:** authorization code + PKCE, with `state` and `nonce`. Each pending login
  (state, nonce, verifier, return URL) rides in its own short-lived encrypted cookie named after
  its state, so two tabs opened by a double tap do not overwrite each other; no server state.
  At most 3 pending login cookies are kept (older abandoned ones are cleared when a new sign-in
  starts), and every callback outcome (success, 400, 403, 500) clears its own.
  Redirect URI: `<origin>/auth/callback`. `returnTo` must be same-origin (no open redirect); if it
  is not, the callback only says "signed in" instead of redirecting anywhere.
- **Session:** after the callback KAGI sets its own cookie: a JWE (`dir` + `A256GCM`, and only
  those algorithms are accepted when opening it) holding `sub`, a display name and the claims
  named in `keepClaims` (the server keeps only the top-level claim its authorizer reads), with
  that list claim narrowed to entries with the allow prefix (`narrowClaim`, e.g. only `door:*`
  groups out of hundreds). `__Host-` prefixed, `HttpOnly`, `SameSite=Lax`. Lifetime
  `KAGI_SESSION_TTL_SECONDS` (12 h). A cookie over ~4 KB would be dropped silently and loop the
  sign-in, so it fails with an error that tells the administrator to use a door-group prefix.
- **Sign out:** the door page has a small "Sign out" button (`POST /auth/logout`).
- **Trade-off — no per-session revocation.** Without a database a session lives until it
  expires. Removing someone at the provider takes effect at their next sign-in (≤ TTL);
  rotating `KAGI_SESSION_SECRET` signs everyone out immediately. `POST /auth/logout` clears only
  the browser that sends it. Clerk's adapter revokes instantly but ties KAGI to Clerk; that is
  why it remains an option, not the default.
- **Authorization:** `claimAllowList("groups", { prefix: "door:" })` by default, i.e. a provider
  group named `door:home` opens door `home`, `door:*` opens all.

#### API for other apps

`POST /api/doors/:doorId/unlock` exists only when an API authenticator is configured.
`jwtBearerAuthenticator` verifies `Authorization: Bearer <JWT>` against the issuer's JWKS:
`iss`, `exp` and `sub` always, plus `aud` and/or allowed `azp`, **at least one of which is
required** (otherwise any token the issuer ever signed for any app would open the door; the
server refuses to start without one). Typical use: HCM's server forwards the signed-in user's
Clerk session token; KAGI needs no Clerk SDK for that. The same Gate runs, so the cooldown and
audit trail are shared with the door page. The route marks the principal `via: "api"`, so API
callers can be authorized by a different claim (`KAGI_API_ALLOW_CLAIM` / `KAGI_API_ALLOW_PREFIX`,
e.g. Clerk metadata) than the door page. Lock credentials stay in KAGI. A bad token is 401; an
issuer that cannot be reached (discovery or JWKS fetch fails) is 503 with `Retry-After`, so the
caller retries instead of treating its token as bad.

### Presence (optional)

```ts
/**
 * Proves the request comes from a physical tap on this door's tag, not a remembered URL.
 * Default: none (static URL). Planned: NTAG 424 DNA SUN (per-tap CMAC + monotonic counter).
 */
interface PresenceVerifier {
  verify(input: { doorId: string; url: URL }): Promise<{ ok: true } | { ok: false; reason: string }>;
}
```

### Authorization

```ts
interface AuthorizationInput {
  principal: Principal;
  door: DoorConfig;
  now: Date;
}

type Decision = { allow: true } | { allow: false; reason: string };

interface Authorizer {
  authorize(input: AuthorizationInput): Promise<Decision>;
}

// Built-ins (in @kagi/core)
declare function allOf(...a: Authorizer[]): Authorizer;
declare function anyOf(...a: Authorizer[]): Authorizer;
/** Allow when the claim at a dot path (string[]) contains `${prefix}${door.id}` or `${prefix}*`. */
declare function claimAllowList(path: string, opts?: { prefix?: string }): Authorizer;
/** Allow only within weekly windows in a given IANA time zone. */
declare function timeWindow(opts: { timeZone: string; windows: WeeklyWindow[] }): Authorizer;
/** Delegate to an external HTTP endpoint (e.g. an HR/shift system). */
declare function httpAuthorizer(opts: { url: string; headers?: Record<string, string>; timeoutMs?: number }): Authorizer;
```

`reason` is for logs and the denial page; it must not leak secrets.

### Audit

```ts
// Every event also carries `via` ("web" | "api") when the HTTP adapter set it.
type AuditEvent =
  | { type: "unlock.denied"; at: Date; requestId: string; principalId: string; doorId: string; reason: string }
  | { type: "unlock.failed"; at: Date; requestId: string; principalId: string; doorId: string; reason: CommandFailureReason; detail?: string }
  // detail: the unclear failure (timeout, network error) that preceded a read-back of "unlocked"
  | { type: "unlock.succeeded"; at: Date; requestId: string; principalId: string; doorId: string; verified: boolean; durationMs: number; detail?: string };

interface AuditSink {
  record(event: AuditEvent): void | Promise<void>;   // must not throw into the unlock path
}
```

### Gate (the core)

```ts
interface GateOptions {
  doors: DoorConfig[];
  drivers: Record<string, LockDriver>;
  authorizer: Authorizer;
  audit?: AuditSink;                 // default: JSON lines to stdout
  commandTimeoutMs?: number;         // default 10_000
  verify?: { timeoutMs: number; intervalMs: number; clockSkewMs?: number };  // default 8_000 / 1_000 / 2_000
  cooldownMs?: number;               // per principal+door after a success, in-memory; default 5_000
  failureCooldownMs?: number;        // after a failure, so repeated presses spare the vendor quota; default 2_000
  now?: () => Date;
}

type UnlockOutcome =
  | { status: "unlocked"; verified: boolean }          // verified=false: no fresh state could be read
  | { status: "denied"; reason: string }
  // uncertain: no clear answer and nothing readable, so the door may already be open
  | { status: "failed"; reason: CommandFailureReason; retryable: boolean; uncertain?: boolean }
  | { status: "cooldown"; retryAfterMs: number }       // pressed again soon after a success or failure
  | { status: "busy" }                                 // pressed again while the previous press runs
  | { status: "unknown_door" };

interface Gate {
  door(id: string): DoorConfig | undefined;
  unlock(input: { principal: Principal; doorId: string; requestId?: string }): Promise<UnlockOutcome>;
}

declare function createGate(opts: GateOptions): Gate;
```

`unlock()` order: door lookup → authorize → in-flight / cooldown check → driver.unlock (with
timeout) → read back (if `capabilities.readState`: poll `getState` until a fresh `unlocked` or
`jammed`, for `verify.timeoutMs`; stale readings are skipped) → audit. Authorization comes first
so a denied person cannot probe the cooldown. The outcome follows what was read back:

| Command | Read back (fresh) | Outcome |
| --- | --- | --- |
| accepted | `unlocked` | `unlocked`, verified (also when it was already open, if the reading is fresh) |
| accepted | `locked` | `failed: not_confirmed`, retryable (nothing opened, e.g. hub offline) |
| accepted | nothing fresh readable | `unlocked`, verified=false |
| ambiguous (timeout, network error, 5xx) | `unlocked` | `unlocked`, verified; the audit event keeps the failure in `detail` |
| ambiguous | `locked` | `failed`, retryable |
| ambiguous | nothing fresh readable | `failed`, **not** retryable, `uncertain`: the door may be open, check it first |
| clear refusal (4xx, offline, unauthorized, rate limited, …) | not read | `failed` with the driver's `retryable` |
| any | `jammed` | `failed: jammed` |

After a success the same person and door wait `cooldownMs`; after a failure `failureCooldownMs`
(short, so "Try again" works within seconds without hammering the vendor). A press while the
previous one is still running is `busy`. State reads that fail or time out are logged with the
request id, and so is a read-back that only ever saw stale readings.

## HTTP adapter contract (apps/server)

| Route | Behaviour |
| --- | --- |
| `GET /d/:doorId` | Unknown door → 404. Not signed in → follow the authenticator's response (sign-in, handshake). Otherwise a page with the door name, one **Unlock** button, and a small **Sign out** button when the authenticator has a `logoutPath`. (Presence verification: not implemented yet.) |
| `GET /healthz` | `ok`, for Cloud Run probes. |
| `* /auth/*` | Delegated to `Authenticator.handle` (OIDC callback; logout is POST-only and same-origin). |
| `POST /api/doors/:doorId/unlock` | Only when an API authenticator is configured. Bearer JWT → `gate.unlock()` → JSON `UnlockOutcome`. |
| `POST /d/:doorId/unlock` | Same-origin check (`hono/csrf`) → authenticate (not signed in → 303 to the door page) → `gate.unlock()` → result page. "Try again" only when `retryable`; "check the door first" only when `uncertain`; `busy` is 409. |

Nothing else. No admin UI: doors are config, people are managed in the identity provider.

## Open questions

- [ ] Presence: ship static URLs first and add NTAG 424 SUN later, or require SUN from day one?
- [ ] Should `lock()` be exposed in the UI at all (e.g. "lock" button when leaving)? Drivers implement it; `bun run probe` uses it.
- [x] Driver credentials: account credentials go to the driver instance (one instance per vendor
      account, keyed in `drivers`); per-device secrets (SESAME `secretKey`) go in `DoorConfig.device`.
- [ ] SESAME: verify on a real device — signing uses bytes 1..3 of the little-endian timestamp
      (as the published clients do; the official wording says "most-significant byte"), non-ASCII
      history labels, SESAME 5 support via Hub3, and error status codes.
- [ ] SwitchBot: confirm unlock latency and whether Hub-routed commands are synchronous for Lock Pro.

## Vendor notes (checked 2026-10-23)

- **SwitchBot** OpenAPI v1.1: `POST /v1.1/devices/{id}/commands` with `{command: "unlock"|"lock", parameter: "default"}`;
  `GET /v1.1/devices/{id}/status` → `body.lockState` = `lock` / `unlock` / `jammed` / `latchBoltLocked`
  (Ultra, Vision, Pro Matter). Errors arrive as HTTP 200 + `statusCode` (161 device offline, 171 hub offline,
  152 not found, 190 internal). 10,000 requests/day; exceeding it returns **401**, not 429.
- **SESAME** Web API: `POST https://app.candyhouse.co/api/sesame2/{uuid}/cmd` with `x-api-key` and
  `{cmd: 82 lock | 83 unlock | 88 toggle, history: base64(label), sign: hex(AES-CMAC(secretKey, ts))}`;
  `GET …/{uuid}` → `CHSesame2Status` = `locked` / `unlocked` / `moved`. Requires Hub3 or Wi-Fi Module 2.
  Unpublished rate limit (reports of HTTP 429 under frequent polling), so verification polls once a second at most.
