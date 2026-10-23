import { clerkAuthenticator } from "@kagi/auth-clerk";
import { jwtBearerAuthenticator, oidcAuthenticator } from "@kagi/auth-oidc";
import { allOf, type Authenticator, type Authorizer, claimAllowList, type DoorConfig, httpAuthorizer, isValidDoorId, type LockDriver } from "@kagi/core";
import { sesameDriver } from "@kagi/driver-sesame";
import { switchbotDriver } from "@kagi/driver-switchbot";
import { en, ja, type Messages } from "@kagi/server";

export interface Config {
  port: number;
  publicOrigin: string;
  doors: DoorConfig[];
  drivers: Record<string, LockDriver>;
  authorizer: Authorizer;
  authenticator: Authenticator;
  api?: Authenticator;
  messages: Messages;
}

type Env = Record<string, string | undefined>;

/**
 * Everything comes from the environment (on Cloud Run: plain env vars + Secret Manager).
 * See .env.example for the full list.
 */
/**
 * What the OIDC session cookie keeps (size limit ~4 KB): only the claim the authorizer reads, by its
 * top-level key, and of that list only the entries with the allow prefix (door groups among many).
 */
export function sessionClaims(allowClaim: string, allowPrefix: string) {
  return { keepClaims: [allowClaim.split(".")[0] as string], narrowClaim: { path: allowClaim, prefix: allowPrefix } };
}

export function loadConfig(env: Env): Config {
  const required = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`kagi: missing env ${name}`);
    return v;
  };
  const list = (v: string | undefined) => v?.split(",").map((s) => s.trim()).filter(Boolean);
  /** Fails at startup, not at the first sign-in, when a number is malformed. */
  const positiveInt = (name: string, fallback: number) => {
    const v = env[name];
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`kagi: ${name} must be a positive integer, got "${v}"`);
    return n;
  };

  const publicOrigin = new URL(required("KAGI_PUBLIC_ORIGIN")).origin;

  const drivers: Record<string, LockDriver> = {};
  if (env.SESAME_API_KEY) drivers.sesame = sesameDriver({ apiKey: env.SESAME_API_KEY }) as LockDriver;
  if (env.SWITCHBOT_TOKEN || env.SWITCHBOT_SECRET) {
    drivers.switchbot = switchbotDriver({ token: required("SWITCHBOT_TOKEN"), secret: required("SWITCHBOT_SECRET") }) as LockDriver;
  }

  let doors: unknown;
  try {
    doors = JSON.parse(required("KAGI_DOORS"));
  } catch (err) {
    throw new Error(`kagi: KAGI_DOORS is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(doors)) throw new Error("kagi: KAGI_DOORS must be a JSON array of doors");
  doors.forEach((d: Partial<Record<keyof DoorConfig, unknown>>, i) => {
    // id is a URL segment written on NFC tags: keep it plain (same rule as createGate).
    if (typeof d?.id !== "string" || !isValidDoorId(d.id)) throw new Error(`kagi: KAGI_DOORS[${i}].id must be 1-64 letters, digits, ".", "_" or "-" (not "." or "..")`);
    if (typeof d.name !== "string" || !d.name) throw new Error(`kagi: KAGI_DOORS[${i}].name must be a non-empty string`);
    if (typeof d.driver !== "string") throw new Error(`kagi: KAGI_DOORS[${i}].driver must be a string`);
  });

  // ---- Who may open which door: defaults depend on the sign-in method ----------
  const authKind = env.KAGI_AUTH ?? "oidc";
  if (authKind !== "oidc" && authKind !== "clerk") throw new Error(`kagi: KAGI_AUTH must be "oidc" or "clerk", got "${authKind}"`);
  const defaults = authKind === "oidc" ? { claim: "groups", prefix: "door:" } : { claim: "publicMetadata.doors", prefix: "" };
  const allowClaim = env.KAGI_ALLOW_CLAIM ?? defaults.claim;
  const allowPrefix = env.KAGI_ALLOW_PREFIX ?? defaults.prefix;

  // ---- Sign-in for the door page --------------------------------------------
  let authenticator: Authenticator;
  if (authKind === "oidc") {
    authenticator = oidcAuthenticator({
      issuer: required("OIDC_ISSUER"),
      clientId: required("OIDC_CLIENT_ID"),
      ...(env.OIDC_CLIENT_SECRET && { clientSecret: env.OIDC_CLIENT_SECRET }),
      ...(env.OIDC_SCOPES && { scopes: env.OIDC_SCOPES }),
      publicOrigin,
      sessionSecret: required("KAGI_SESSION_SECRET"),
      sessionTtlSeconds: positiveInt("KAGI_SESSION_TTL_SECONDS", 12 * 60 * 60),
      ...sessionClaims(allowClaim, allowPrefix),
      allowInsecureIssuer: env.OIDC_ISSUER?.startsWith("http://") ?? false,
    });
  } else {
    authenticator = clerkAuthenticator({
      secretKey: required("CLERK_SECRET_KEY"),
      publishableKey: required("CLERK_PUBLISHABLE_KEY"),
      authorizedParties: [publicOrigin],
    });
  }

  // ---- Optional API for other apps (bearer JWT) ------------------------------
  let api: Authenticator | undefined;
  if (env.KAGI_API_JWT_ISSUER) {
    const azp = list(env.KAGI_API_JWT_AUTHORIZED_PARTIES);
    if (!env.KAGI_API_JWT_AUDIENCE && !azp?.length) {
      throw new Error("kagi: KAGI_API_JWT_ISSUER needs KAGI_API_JWT_AUDIENCE or KAGI_API_JWT_AUTHORIZED_PARTIES, or tokens issued to other apps would be accepted");
    }
    api = jwtBearerAuthenticator({
      issuer: env.KAGI_API_JWT_ISSUER,
      ...(env.KAGI_API_JWT_JWKS_URL && { jwksUrl: env.KAGI_API_JWT_JWKS_URL }),
      ...(env.KAGI_API_JWT_AUDIENCE && { audience: env.KAGI_API_JWT_AUDIENCE }),
      ...(azp?.length && { authorizedParties: azp }),
    });
  }

  // ---- Authorization -----------------------------------------------------------
  // A list claim (default: OIDC "groups" with entries like "door:home"). API callers may carry a
  // different token (e.g. Clerk's), so they get their own claim settings. Optionally AND an
  // external endpoint (shift system etc.) for both.
  const webRule = claimAllowList(allowClaim, { prefix: allowPrefix });
  const apiRule = claimAllowList(env.KAGI_API_ALLOW_CLAIM ?? allowClaim, { prefix: env.KAGI_API_ALLOW_PREFIX ?? allowPrefix });
  const rules: Authorizer[] = [{ authorize: (input) => (input.principal.via === "api" ? apiRule : webRule).authorize(input) }];
  if (env.KAGI_AUTHORIZER_URL) {
    rules.push(
      httpAuthorizer({
        url: env.KAGI_AUTHORIZER_URL,
        ...(env.KAGI_AUTHORIZER_TOKEN && { headers: { authorization: `Bearer ${env.KAGI_AUTHORIZER_TOKEN}` } }),
      }),
    );
  }

  const port = positiveInt("PORT", 8080);
  if (port > 65535) throw new Error(`kagi: PORT must be at most 65535, got ${port}`);

  return {
    port,
    publicOrigin,
    doors: doors as DoorConfig[],
    drivers,
    authorizer: rules.length === 1 ? (rules[0] as Authorizer) : allOf(...rules),
    authenticator,
    ...(api && { api }),
    messages: env.KAGI_LANG === "ja" ? ja : en,
  };
}
