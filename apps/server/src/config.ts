import { allOf, claimAllowList, type Authorizer, type DoorConfig, httpAuthorizer, type LockDriver } from "@kagi/core";
import { sesameDriver } from "@kagi/driver-sesame";
import { switchbotDriver } from "@kagi/driver-switchbot";
import { en, ja, type Messages } from "@kagi/server";

export interface Config {
  port: number;
  publicOrigin: string;
  doors: DoorConfig[];
  drivers: Record<string, LockDriver>;
  authorizer: Authorizer;
  clerk: { secretKey: string; publishableKey: string };
  messages: Messages;
}

/**
 * Everything comes from the environment (on Cloud Run: plain env vars + Secret Manager).
 * See .env.example for the full list.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const required = (name: string) => {
    const v = env[name];
    if (!v) throw new Error(`kagi: missing env ${name}`);
    return v;
  };

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

  // Who may open which door: the list in Clerk publicMetadata (default), optionally AND an
  // external endpoint (shift system etc.).
  const rules: Authorizer[] = [claimAllowList(env.KAGI_ALLOW_CLAIM ?? "publicMetadata.doors")];
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
    publicOrigin: new URL(required("KAGI_PUBLIC_ORIGIN")).origin,
    doors: doors as DoorConfig[],
    drivers,
    authorizer: rules.length === 1 ? (rules[0] as Authorizer) : allOf(...rules),
    clerk: { secretKey: required("CLERK_SECRET_KEY"), publishableKey: required("CLERK_PUBLISHABLE_KEY") },
    messages: env.KAGI_LANG === "ja" ? ja : en,
  };
}
