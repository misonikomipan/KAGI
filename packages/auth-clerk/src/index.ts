import { createClerkClient } from "@clerk/backend";
import { constants, createRedirect } from "@clerk/backend/internal";
import type { Authenticator, Principal } from "@kagi/core";

export interface ClerkAuthenticatorOptions {
  secretKey: string;
  publishableKey: string;
  /**
   * Origins allowed to have issued the session token, e.g. ["https://door.example.com"].
   * Strongly recommended in production.
   */
  authorizedParties?: string[];
  /** Override the sign-in page. Default: Clerk's hosted Account Portal for this instance. */
  signInUrl?: string;
}

/**
 * Authenticates with Clerk's session cookie. KAGI renders no sign-in UI: signed-out users are
 * sent to the Account Portal and come back to `returnTo`.
 *
 * Principal.claims carries `publicMetadata`, `email`, `orgId` and `orgRole`, which is what the
 * built-in authorizers look at (e.g. `claimAllowList("publicMetadata.doors")`).
 */
export function clerkAuthenticator(opts: ClerkAuthenticatorOptions): Authenticator {
  const clerk = createClerkClient({ secretKey: opts.secretKey, publishableKey: opts.publishableKey });

  return {
    async authenticate(req, { returnTo }) {
      const state = await clerk.authenticateRequest(req, {
        ...(opts.authorizedParties && { authorizedParties: opts.authorizedParties }),
        ...(opts.signInUrl && { signInUrl: opts.signInUrl }),
      });

      // Handshake: Clerk needs one redirect round-trip to refresh the session cookie.
      const location = state.headers.get("location");
      if (location) return { ok: false, response: new Response(null, { status: 307, headers: state.headers }) };

      const auth = state.isAuthenticated ? state.toAuth() : null;
      if (!auth?.userId) {
        const dbToken = devBrowserToken(req);
        const { redirectToSignIn } = createRedirect<Response>({
          publishableKey: opts.publishableKey,
          baseUrl: new URL(req.url).origin,
          ...(opts.signInUrl && { signInUrl: opts.signInUrl }),
          ...(dbToken && { devBrowserToken: dbToken }),
          redirectAdapter: (url) => Response.redirect(url, 303),
        });
        return { ok: false, response: redirectToSignIn({ returnBackUrl: returnTo }) };
      }

      const user = await clerk.users.getUser(auth.userId);
      const email = user.primaryEmailAddress?.emailAddress ?? null;
      const principal: Principal = {
        id: user.id,
        displayName: user.fullName ?? user.username ?? email ?? user.id,
        claims: {
          publicMetadata: user.publicMetadata,
          email,
          orgId: auth.orgId ?? null,
          orgRole: auth.orgRole ?? null,
        },
      };
      return { ok: true, principal };
    },
  };
}

/** Development instances track the browser with a token instead of a first-party cookie. */
function devBrowserToken(req: Request): string | undefined {
  const name = constants.Cookies.DevBrowser;
  const fromQuery = new URL(req.url).searchParams.get(constants.QueryParameters.DevBrowser);
  if (fromQuery) return fromQuery;
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}
