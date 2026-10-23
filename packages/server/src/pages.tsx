import type { Child } from "hono/jsx";
import type { Messages } from "./messages.ts";

const css = `
:root { --bg: #f6f5f2; --fg: #1c1b19; --muted: #6b6862; --accent: #1f6f43; --accent-fg: #fff; --bad: #a3281c; --card: #fff; --line: #e3e0da; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #151514; --fg: #ecebe8; --muted: #a09d97; --accent: #3fa36b; --accent-fg: #0d1a12; --bad: #e36a5c; --card: #1f1f1d; --line: #33322f; }
}
* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif; padding: 16px; }
main { width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 32px 24px; text-align: center; }
h1 { font-size: 1.5rem; margin: 0 0 4px; }
p { margin: 8px 0; }
.muted { color: var(--muted); font-size: .875rem; }
.status { font-size: 1.25rem; font-weight: 600; margin: 0 0 8px; }
.ok { color: var(--accent); } .bad { color: var(--bad); }
button, .link { display: block; width: 100%; margin-top: 24px; padding: 18px; border: 0; border-radius: 12px; font: inherit; font-size: 1.25rem; font-weight: 600; text-decoration: none; cursor: pointer; }
button { background: var(--accent); color: var(--accent-fg); }
.link { background: transparent; color: var(--fg); border: 1px solid var(--line); font-size: 1rem; padding: 14px; }
`;

function Layout(props: { m: Messages; title: string; children: Child }) {
  return (
    <html lang={props.m.lang}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{props.title}</title>
        <style>{css}</style>
      </head>
      <body>
        <main>{props.children}</main>
      </body>
    </html>
  );
}

export function DoorPage(props: { m: Messages; doorName: string; action: string; userName: string }) {
  const { m } = props;
  return (
    <Layout m={m} title={props.doorName}>
      <h1>{props.doorName}</h1>
      <p class="muted">{m.signedInAs(props.userName)}</p>
      <form method="post" action={props.action}>
        <button type="submit">{m.unlockButton}</button>
      </form>
    </Layout>
  );
}

export function ResultPage(props: {
  m: Messages;
  doorName: string;
  ok: boolean;
  message: string;
  detail?: string | undefined;
  backHref: string;
  backLabel: string;
}) {
  return (
    <Layout m={props.m} title={props.doorName}>
      <h1>{props.doorName}</h1>
      <p class={`status ${props.ok ? "ok" : "bad"}`} role="status">
        {props.message}
      </p>
      {props.detail && <p class="muted">{props.detail}</p>}
      <a class="link" href={props.backHref}>
        {props.backLabel}
      </a>
    </Layout>
  );
}

export function NotFoundPage(props: { m: Messages }) {
  return <MessagePage m={props.m} message={props.m.notFound} />;
}

export function MessagePage(props: { m: Messages; message: string }) {
  return (
    <Layout m={props.m} title="KAGI">
      <p class="status bad">{props.message}</p>
    </Layout>
  );
}
