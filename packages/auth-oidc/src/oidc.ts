import type { Authenticator, Principal } from "@kagi/core";
import * as client from "openid-client";
import { CookieSealer, readCookie, serializeCookie } from "./cookies.ts";

export interface OidcAuthenticatorOptions {
  /** e.g. "https://id.example.com" (Pocket ID), "https://accounts.google.com". */
  issuer: string;
  clientId: string;
  /** Omit for a public client (PKCE only). */
  clientSecret?: string;
  /** KAGI's public origin; the redirect URI is `${publicOrigin}/auth/callback`. */
  publicOrigin: string;
  /** At least 32 random characters. Encrypts the session and login cookies. */
  sessionSecret: string;
  /** Default "openid profile email". Pocket ID: add "groups". */
  scopes?: string;
  /** How long a sign-in lasts at KAGI. Default 12 hours. */
  sessionTtlSeconds?: number;
  /** Also merge the userinfo endpoint's claims (some providers put groups only there). Default true. */
  userinfo?: boolean;
  /** Allow an http:// issuer, for local development only. */
  allowInsecureIssuer?: boolean;
  /** For tests: replaces fetch for every request to the provider. */
  fetch?: typeof fetch;
}

interface LoginTx {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

interface Session {
  sub: string;
  name: string;
  claims: Record<string, unknown>;
}

const LOGIN_TTL_SECONDS = 600;
/** Protocol claims that say nothing about the person; dropped to keep the cookie small. */
const PROTOCOL_CLAIMS = new Set(["iss", "aud", "exp", "iat", "nbf", "nonce", "at_hash", "c_hash", "auth_time", "azp", "sid", "jti", "acr", "amr"]);

/**
 * Sign-in with any OpenID Connect provider (authorization code + PKCE). After the callback KAGI
 * keeps its own encrypted session cookie, so there is still no database. A session cannot be
 * revoked individually before it expires; keep sessionTtlSeconds modest, or rotate the secret.
 */
export function oidcAuthenticator(opts: OidcAuthenticatorOptions): Authenticator {
  const origin = new URL(opts.publicOrigin).origin;
  const secure = origin.startsWith("https:");
  // __Host- pins the cookie to this exact origin; it requires Secure, so not on http://localhost.
  const SESSION = secure ? "__Host-kagi_session" : "kagi_session";
  const LOGIN = secure ? "__Host-kagi_login" : "kagi_login";
  const redirectUri = `${origin}/auth/callback`;
  const ttl = opts.sessionTtlSeconds ?? 12 * 60 * 60;
  const sealer = new CookieSealer(opts.sessionSecret);

  let discovered: Promise<client.Configuration> | undefined;
  const config = () => {
    discovered ??= client
      .discovery(
        new URL(opts.issuer),
        opts.clientId,
        undefined,
        opts.clientSecret ? client.ClientSecretPost(opts.clientSecret) : client.None(),
        {
          ...(opts.allowInsecureIssuer && { execute: [client.allowInsecureRequests] }),
          ...(opts.fetch && { [client.customFetch]: opts.fetch as client.CustomFetch }),
        },
      )
      .catch((err: unknown) => {
        discovered = undefined; // retry on the next request instead of caching the failure
        throw err;
      });
    return discovered;
  };

  const sameOrigin = (url: string) => {
    try {
      const u = new URL(url, origin);
      return u.origin === origin ? u.toString() : null;
    } catch {
      return null;
    }
  };

  const redirect = (location: string, cookies: string[]) => {
    const headers = new Headers({ location });
    for (const c of cookies) headers.append("set-cookie", c);
    return new Response(null, { status: 303, headers });
  };

  const text = (status: number, body: string) =>
    new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

  async function callback(req: Request): Promise<Response> {
    const tx = await sealer.open<LoginTx>(readCookie(req, LOGIN), "login");
    if (!tx) return text(400, "Sign-in expired or was started in another browser. Open the door link again.");
    const clearLogin = serializeCookie(LOGIN, "", { secure, maxAge: 0 });

    let claims: Record<string, unknown>;
    try {
      const cfg = await config();
      const tokens = await client.authorizationCodeGrant(cfg, new URL(req.url), {
        pkceCodeVerifier: tx.verifier,
        expectedState: tx.state,
        expectedNonce: tx.nonce,
        idTokenExpected: true,
      });
      const idClaims = tokens.claims();
      if (!idClaims) throw new Error("no ID token");
      claims = { ...idClaims };
      if (opts.userinfo ?? true) {
        Object.assign(claims, await client.fetchUserInfo(cfg, tokens.access_token, idClaims.sub));
      }
    } catch (err) {
      console.error("kagi: OIDC callback failed", err);
      return text(403, "Sign-in failed.");
    }

    const sub = String(claims.sub);
    for (const k of PROTOCOL_CLAIMS) delete claims[k];
    const name = [claims.name, claims.preferred_username, claims.email].find((v) => typeof v === "string") as string | undefined;
    const session = await sealer.seal({ sub, name: name ?? sub, claims } satisfies Session, ttl, "session");
    return redirect(tx.returnTo, [serializeCookie(SESSION, session, { secure, maxAge: ttl }), clearLogin]);
  }

  return {
    async authenticate(req, { returnTo }) {
      const s = await sealer.open<Session>(readCookie(req, SESSION), "session");
      if (s) {
        const principal: Principal = { id: s.sub, displayName: s.name, claims: s.claims };
        return { ok: true, principal };
      }

      const cfg = await config();
      const tx: LoginTx = {
        state: client.randomState(),
        nonce: client.randomNonce(),
        verifier: client.randomPKCECodeVerifier(),
        returnTo: sameOrigin(returnTo) ?? `${origin}/`,
      };
      const url = client.buildAuthorizationUrl(cfg, {
        redirect_uri: redirectUri,
        scope: opts.scopes ?? "openid profile email",
        state: tx.state,
        nonce: tx.nonce,
        code_challenge: await client.calculatePKCECodeChallenge(tx.verifier),
        code_challenge_method: "S256",
      });
      const login = await sealer.seal({ ...tx }, LOGIN_TTL_SECONDS, "login");
      return { ok: false, response: redirect(url.toString(), [serializeCookie(LOGIN, login, { secure, maxAge: LOGIN_TTL_SECONDS })]) };
    },

    async handle(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/auth/callback" && req.method === "GET") return callback(req);
      if (pathname === "/auth/logout") {
        const headers = new Headers({ "content-type": "text/plain; charset=utf-8" });
        headers.append("set-cookie", serializeCookie(SESSION, "", { secure, maxAge: 0 }));
        return new Response("Signed out of KAGI.", { status: 200, headers });
      }
      return null;
    },
  };
}
