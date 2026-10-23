import type { Authenticator, Gate, UnlockOutcome } from "@kagi/core";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import { en, type Messages } from "./messages.ts";
import { DoorPage, NotFoundPage, ResultPage } from "./pages.tsx";

export { en, ja, type Messages } from "./messages.ts";

export interface KagiAppOptions {
  gate: Gate;
  authenticator: Authenticator;
  /**
   * Public origin, e.g. "https://door.example.com". Behind a TLS-terminating proxy (Cloud Run)
   * the request URL says http://; this is what sign-in redirects and the Origin check use.
   */
  publicOrigin: string;
  messages?: Messages;
}

/**
 * The whole web surface: one page with a button, one POST that unlocks. Nothing else.
 *
 *   GET  /d/:doorId          sign in if needed, then show the Unlock button (never unlocks)
 *   POST /d/:doorId/unlock   same-origin only; unlock and show the result
 */
export function createKagiApp(opts: KagiAppOptions): Hono {
  const m = opts.messages ?? en;
  const origin = new URL(opts.publicOrigin).origin;
  const app = new Hono();

  app.use(secureHeaders({ referrerPolicy: "same-origin" }));
  app.use(async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });
  app.use(csrf({ origin }));

  app.get("/healthz", (c) => c.text("ok"));

  /** The request as the browser addressed it, for the identity provider. */
  const publicRequest = (req: Request) => {
    const u = new URL(req.url);
    return new Request(new URL(u.pathname + u.search, origin), req);
  };
  const doorPath = (id: string) => `/d/${encodeURIComponent(id)}`;

  app.get("/d/:doorId", async (c) => {
    const door = opts.gate.door(c.req.param("doorId"));
    if (!door) return c.html(<NotFoundPage m={m} />, 404);

    const auth = await opts.authenticator.authenticate(publicRequest(c.req.raw), {
      returnTo: new URL(doorPath(door.id), origin).toString(),
    });
    if (!auth.ok) return auth.response;

    return c.html(
      <DoorPage m={m} doorName={door.name} action={`${doorPath(door.id)}/unlock`} userName={auth.principal.displayName} />,
    );
  });

  app.post("/d/:doorId/unlock", async (c) => {
    const door = opts.gate.door(c.req.param("doorId"));
    if (!door) return c.html(<NotFoundPage m={m} />, 404);
    const back = doorPath(door.id);

    const auth = await opts.authenticator.authenticate(publicRequest(c.req.raw), {
      returnTo: new URL(back, origin).toString(),
    });
    // Sign-in and session handshakes are GET round-trips; never replay the POST through them.
    if (!auth.ok) return c.redirect(back, 303);

    const outcome = await opts.gate.unlock({ principal: auth.principal, doorId: door.id });
    const view = describe(outcome, m);
    return c.html(
      <ResultPage m={m} doorName={door.name} ok={view.ok} message={view.message} detail={view.detail} backHref={back} backLabel={view.ok ? m.back : m.retry} />,
      view.status,
    );
  });

  app.notFound((c) => c.html(<NotFoundPage m={m} />, 404));
  return app;
}

function describe(o: UnlockOutcome, m: Messages): { ok: boolean; status: ContentfulStatusCode; message: string; detail?: string } {
  switch (o.status) {
    case "unlocked":
      return { ok: true, status: 200, message: o.verified ? m.unlocked : m.unlockedUnverified };
    case "denied":
      return { ok: false, status: 403, message: m.denied };
    case "failed":
      return { ok: false, status: 502, message: m.failed[o.reason] };
    case "cooldown":
      return { ok: false, status: 429, message: m.cooldown(Math.ceil(o.retryAfterMs / 1000)) };
    case "unknown_door":
      return { ok: false, status: 404, message: m.notFound };
  }
}
