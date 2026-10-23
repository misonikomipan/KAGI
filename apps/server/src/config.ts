import { clerkAuthenticator } from "@kagi/auth-clerk";
import { jwtBearerAuthenticator, oidcAuthenticator } from "@kagi/auth-oidc";
import { allOf, type Authenticator, type Authorizer, claimAllowList, type DoorConfig, httpAuthorizer, type LockDriver } from "@kagi/core";
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
export function loadConfig(env: Env): Config {
  const required = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`kagi: missing env ${name}`);
    return v;
  };
  const list = (v: string | undefined) => v?.split(",").map((s) => s.trim()).filter(Boolean);

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

  // ---- Sign-in for the door page --------------------------------------------
  const authKind = env.KAGI_AUTH ?? "oidc";
  let authenticator: Authenticator;
  let defaultClaim: { path: string; prefix: string };
  if (authKind === "oidc") {
    authenticator = oidcAuthenticator({
      issuer: required("OIDC_ISSUER"),
      clientId: required("OIDC_CLIENT_ID"),
      ...(env.OIDC_CLIENT_SECRET && { clientSecret: env.OIDC_CLIENT_SECRET }),
      ...(env.OIDC_SCOPES && { scopes: env.OIDC_SCOPES }),
      publicOrigin,
      sessionSecret: required("KAGI_SESSION_SECRET"),
      ...(env.KAGI_SESSION_TTL_SECONDS && { sessionTtlSeconds: Number(env.KAGI_SESSION_TTL_SECONDS) }),
      allowInsecureIssuer: env.OIDC_ISSUER?.startsWith("http://") ?? false,
    });
    defaultClaim = { path: "groups", prefix: "door:" };
  } else if (authKind === "clerk") {
    authenticator = clerkAuthenticator({
      secretKey: required("CLERK_SECRET_KEY"),
      publishableKey: required("CLERK_PUBLISHABLE_KEY"),
      authorizedParties: [publicOrigin],
    });
    defaultClaim = { path: "publicMetadata.doors", prefix: "" };
  } else {
    throw new Error(`kagi: KAGI_AUTH must be "oidc" or "clerk", got "${authKind}"`);
  }

  // ---- Optional API for other apps (bearer JWT) ------------------------------
  let api: Authenticator | undefined;
  if (env.KAGI_API_JWT_ISSUER) {
    const azp = list(env.KAGI_API_JWT_AUTHORIZED_PARTIES);
    api = jwtBearerAuthenticator({
      issuer: env.KAGI_API_JWT_ISSUER,
      ...(env.KAGI_API_JWT_JWKS_URL && { jwksUrl: env.KAGI_API_JWT_JWKS_URL }),
      ...(env.KAGI_API_JWT_AUDIENCE && { audience: env.KAGI_API_JWT_AUDIENCE }),
      ...(azp && { authorizedParties: azp }),
    });
  }

  // ---- Who may open which door -----------------------------------------------
  // A list claim (default: OIDC "groups" with entries like "door:home"), optionally AND an
  // external endpoint (shift system etc.).
  const rules: Authorizer[] = [
    claimAllowList(env.KAGI_ALLOW_CLAIM ?? defaultClaim.path, { prefix: env.KAGI_ALLOW_PREFIX ?? defaultClaim.prefix }),
  ];
  if (env.KAGI_AUTHORIZER_URL) {
    rules.push(
      httpAuthorizer({
        url: env.KAGI_AUTHORIZER_URL,
        ...(env.KAGI_AUTHORIZER_TOKEN && { headers: { authorization: `Bearer ${env.KAGI_AUTHORIZER_TOKEN}` } }),
      }),
    );
  }

  return {
    port: Number(env.PORT ?? 8080),
    publicOrigin,
    doors: doors as DoorConfig[],
    drivers,
    authorizer: rules.length === 1 ? (rules[0] as Authorizer) : allOf(...rules),
    authenticator,
    ...(api && { api }),
    messages: env.KAGI_LANG === "ja" ? ja : en,
  };
}
