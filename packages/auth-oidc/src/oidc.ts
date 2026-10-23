import type { Authenticator, Principal } from "@kagi/core";
import * as client from "openid-client";
import { CookieSealer, cookieNames, readCookie, serializeCookie } from "./cookies.ts";

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
  /**
   * Top-level claims kept in the session cookie besides `sub` and the display name, e.g.
   * ["groups"]. Keep only what authorizers read: browsers drop cookies over ~4 KB. Default: all
   * claims except protocol ones (iss, aud, exp, nonce, ...).
   */
  keepClaims?: string[];
  /**
   * Before saving, keep only the entries of a list claim that start with `prefix`, e.g.
   * { path: "groups", prefix: "door:" } drops all other groups. Accounts with many groups
   * (Entra ID, Google Workspace) then still fit in the cookie.
   */
  narrowClaim?: { path: string; prefix: string };
  /** Allow an http:// issuer, for local development only. */
  allowInsecureIssuer?: boolean;
  /** For tests: replaces fetch for every request to the provider. */
  fetch?: typeof fetch;
}

interface LoginTx {
  state: string;
  nonce: string;
  verifier: string;
  /** "" when the caller's returnTo was not on this origin: the callback then just says "signed in". */
  returnTo: string;
}

interface Session {
  sub: string;
  name: string;
  claims: Record<string, unknown>;
}

const LOGIN_TTL_SECONDS = 600;
/** Pending sign-ins kept per browser; abandoned ones beyond this are cleared at the next start. */
const MAX_PENDING_LOGINS = 3;
/** Browsers keep at most ~4096 bytes per cookie (name, value and attributes). */
const MAX_COOKIE_BYTES = 4000;
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
  // One login cookie per pending sign-in (suffix = start of its state), so two tabs opened by a
  // double tap do not overwrite each other's state.
  const LOGIN_PREFIX = secure ? "__Host-kagi_login_" : "kagi_login_";
  const loginCookie = (state: string) => `${LOGIN_PREFIX}${state.slice(0, 16)}`;
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

  /** A text response that also clears this sign-in's login cookie. */
  const textClearing = (status: number, body: string, clearLogin: string) => {
    const res = text(status, body);
    res.headers.append("set-cookie", clearLogin);
    return res;
  };

  async function callback(req: Request): Promise<Response> {
    const state = new URL(req.url).searchParams.get("state") ?? "";
    const LOGIN = loginCookie(state);
    const clearLogin = serializeCookie(LOGIN, "", { secure, maxAge: 0 });
    const tx = state ? await sealer.open<LoginTx>(readCookie(req, LOGIN), "login") : null;
    if (!tx) {
      const msg = "Sign-in expired or was started in another browser. Open the door link again.";
      return readCookie(req, LOGIN) !== undefined ? textClearing(400, msg, clearLogin) : text(400, msg);
    }

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
      return textClearing(403, "Sign-in failed. Open the door link again.", clearLogin);
    }

    if (opts.narrowClaim?.prefix) narrowList(claims, opts.narrowClaim.path, opts.narrowClaim.prefix);
    const sub = String(claims.sub);
    const name = [claims.name, claims.preferred_username, claims.email].find((v) => typeof v === "string") as string | undefined;
    const kept = opts.keepClaims
      ? Object.fromEntries(opts.keepClaims.filter((k) => k in claims).map((k) => [k, claims[k]]))
      : Object.fromEntries(Object.entries(claims).filter(([k]) => !PROTOCOL_CLAIMS.has(k)));
    const session = serializeCookie(SESSION, await sealer.seal({ sub, name: name ?? sub, claims: kept } satisfies Session, ttl, "session"), { secure, maxAge: ttl });
    if (session.length > MAX_COOKIE_BYTES) {
      // The browser would silently drop it and the sign-in would loop; fail visibly instead.
      console.error(JSON.stringify({ msg: "kagi: session cookie too large", bytes: session.length, claims: Object.keys(kept), narrowedBy: opts.narrowClaim ?? null }));
      return textClearing(
        500,
        "Sign-in worked, but this account has too many groups or claims to fit in a KAGI session. " +
          "Ask the administrator to give door groups a common prefix (e.g. door:) so KAGI keeps only those, or to remove unrelated groups.",
        clearLogin,
      );
    }
    if (!tx.returnTo) {
      const headers = new Headers({ "content-type": "text/plain; charset=utf-8" });
      headers.append("set-cookie", session);
      headers.append("set-cookie", clearLogin);
      return new Response("Signed in to KAGI. Open the door link again.", { status: 200, headers });
    }
    return redirect(tx.returnTo, [session, clearLogin]);
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
        returnTo: sameOrigin(returnTo) ?? "",
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
      // Each abandoned sign-in leaves a login cookie for 10 minutes. Keep at most a few, so the
      // Cookie header cannot grow without bound (two tabs from a double tap still both work).
      const pending = cookieNames(req).filter((n) => n.startsWith(LOGIN_PREFIX));
      const expired = pending.length >= MAX_PENDING_LOGINS ? pending.map((n) => serializeCookie(n, "", { secure, maxAge: 0 })) : [];
      return { ok: false, response: redirect(url.toString(), [...expired, serializeCookie(loginCookie(tx.state), login, { secure, maxAge: LOGIN_TTL_SECONDS })]) };
    },

    logoutPath: "/auth/logout",

    async handle(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/auth/callback" && req.method === "GET") return callback(req);
      // POST only, so another site cannot sign people out with a link or an <img>. This clears
      // this browser's session; it does not revoke anyone elsewhere (rotate the secret for that).
      if (pathname === "/auth/logout" && req.method === "POST") {
        const headers = new Headers({ "content-type": "text/plain; charset=utf-8" });
        headers.append("set-cookie", serializeCookie(SESSION, "", { secure, maxAge: 0 }));
        return new Response("Signed out of KAGI in this browser.", { status: 200, headers });
      }
      return null;
    },
  };
}

/** Keeps only the string entries starting with prefix in the list claim at a dotted path (in place). */
function narrowList(claims: Record<string, unknown>, path: string, prefix: string): void {
  const keys = path.split(".");
  let parent: Record<string, unknown> = claims;
  for (const k of keys.slice(0, -1)) {
    const next: unknown = parent[k];
    if (next === null || typeof next !== "object") return;
    const copy = { ...(next as Record<string, unknown>) }; // do not mutate objects shared with the token
    parent[k] = copy;
    parent = copy;
  }
  const last = keys.at(-1) as string;
  const list = parent[last];
  if (Array.isArray(list)) parent[last] = list.filter((v) => typeof v === "string" && v.startsWith(prefix));
}
