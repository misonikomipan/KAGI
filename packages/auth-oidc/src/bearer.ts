import type { Authenticator } from "@kagi/core";
import { createRemoteJWKSet, customFetch as jwksFetch, type JWTPayload, jwtVerify } from "jose";

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
  const doFetch = opts.fetch ?? fetch;
  let jwks: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;
  const keys = () => {
    jwks ??= (async () => {
      let url = opts.jwksUrl;
      if (!url) {
        const res = await doFetch(new URL(".well-known/openid-configuration", withSlash(opts.issuer)));
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
          ...(opts.audience && { audience: opts.audience }),
        }));
      } catch {
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
