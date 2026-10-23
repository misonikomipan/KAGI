import type { Authenticator } from "@kagi/core";
import { createRemoteJWKSet, errors, customFetch as jwksFetch, type JWTPayload, jwtVerify } from "jose";

/**
 * True when verification failed because the issuer could not be reached (discovery or JWKS
 * fetch), not because the token is bad: network errors, JWKS timeouts, a non-200 / non-JSON
 * JWKS response (jose reports those as generic JOSEErrors or JWKSInvalid).
 */
function issuerUnavailable(err: unknown): boolean {
  if (!(err instanceof errors.JOSEError)) return true;
  return err instanceof errors.JWKSTimeout || err instanceof errors.JWKSInvalid || err.code === "ERR_JOSE_GENERIC";
}

/** At least one of `audience` and `authorizedParties` is required. */
export interface JwtBearerOptions {
  /** Expected `iss`, e.g. Clerk's Frontend API URL or a Pocket ID origin. */
  issuer: string;
  /** Default: `jwks_uri` from `${issuer}/.well-known/openid-configuration`. */
  jwksUrl?: string;
  /** Expected `aud`, if the provider sets one. */
  audience?: string;
  /** Allowed `azp` values (Clerk session tokens carry the calling app's origin here). */
  authorizedParties?: string[];
  /** Claim used as the display name. Default: name, preferred_username, email, then sub. */
  displayNameClaim?: string;
  fetch?: typeof fetch;
}

/**
 * Authenticates API calls from other apps by an `Authorization: Bearer <JWT>` header, verified
 * against the issuer's public keys. No vendor SDK: works with any provider that publishes JWKS.
 */
export function jwtBearerAuthenticator(opts: JwtBearerOptions): Authenticator {
  // Without either check, any token this issuer ever signed for any app would open the door.
  if (!opts.audience && !opts.authorizedParties?.length) {
    throw new Error("kagi: jwtBearerAuthenticator needs `audience` or `authorizedParties` (otherwise tokens issued to other apps are accepted)");
  }
  const doFetch = opts.fetch ?? fetch;
  let jwks: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;
  const keys = () => {
    jwks ??= (async () => {
      let url = opts.jwksUrl;
      if (!url) {
        const res = await doFetch(new URL(".well-known/openid-configuration", withSlash(opts.issuer)), { signal: AbortSignal.timeout(5_000) });
        if (!res.ok) throw new Error(`kagi: OIDC discovery failed: HTTP ${res.status}`);
        url = String(((await res.json()) as { jwks_uri?: unknown }).jwks_uri);
      }
      return createRemoteJWKSet(new URL(url), opts.fetch ? { [jwksFetch]: opts.fetch } : {});
    })().catch((err: unknown) => {
      jwks = undefined;
      throw err;
    });
    return jwks;
  };

  const unauthorized = (error: string) =>
    new Response(JSON.stringify({ status: "unauthenticated", error }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": `Bearer error="invalid_token"` },
    });

  return {
    async authenticate(req) {
      const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
      if (!m?.[1]) return { ok: false, response: unauthorized("missing bearer token") };

      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(m[1], await keys(), {
          issuer: opts.issuer,
          requiredClaims: ["exp", "sub"],
          ...(opts.audience && { audience: opts.audience }),
        }));
      } catch (err) {
        if (issuerUnavailable(err)) {
          // Not the caller's fault: say so, so it retries instead of treating its token as bad.
          console.error(JSON.stringify({ msg: "kagi: bearer token issuer unreachable", error: err instanceof Error ? err.message : String(err) }));
          return {
            ok: false,
            response: new Response(JSON.stringify({ status: "unavailable", error: "token issuer unreachable" }), {
              status: 503,
              headers: { "content-type": "application/json", "retry-after": "5" },
            }),
          };
        }
        return { ok: false, response: unauthorized("invalid token") };
      }
      if (opts.authorizedParties && !opts.authorizedParties.includes(String(payload.azp))) {
        return { ok: false, response: unauthorized("unexpected azp") };
      }
      if (!payload.sub) return { ok: false, response: unauthorized("no sub") };

      const nameKeys = opts.displayNameClaim ? [opts.displayNameClaim] : ["name", "preferred_username", "email"];
      const name = nameKeys.map((k) => payload[k]).find((v) => typeof v === "string") as string | undefined;
      return { ok: true, principal: { id: payload.sub, displayName: name ?? payload.sub, claims: { ...payload } } };
    },
  };
}

function withSlash(u: string): string {
  return u.endsWith("/") ? u : `${u}/`;
}
