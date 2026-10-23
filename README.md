# KAGI — Keyless Access Gate Interface

Tap an NFC tag at the door, sign in, press **Unlock**, and the smart lock opens.

- The NFC tag only carries a URL; it is never the key. Every decision is made server-side.
- Opening the URL never unlocks anything — only the button (a POST) does.
- Smart-lock vendors are pluggable `LockDriver`s. Built in: **SwitchBot** (Lock / Lock Pro / Lock Ultra …) and **SESAME** (via Hub3 / Wi-Fi Module 2).
- Sign-in works with any **OpenID Connect** provider (Pocket ID, Google, Entra ID, Okta, Keycloak, …); KAGI ships no sign-in UI. Clerk is supported as an optional adapter.
- No database: doors are configuration, people live in the identity provider, and the audit trail is JSON lines on stdout.
- Other apps can unlock on a user's behalf through a small JSON API (bearer JWT), sharing the same authorization, cooldown and audit trail.

See [docs/design.md](docs/design.md) for the interfaces and the reasoning behind them.

> **Status:** early development. Everything below is implemented and unit-tested, but has not yet
> been verified against real locks or a real identity provider.

## Packages

| Package | Contents |
| --- | --- |
| `@kagi/core` | Types, `createGate()`, built-in authorizers, stdout audit sink |
| `@kagi/driver-switchbot` | SwitchBot OpenAPI v1.1 |
| `@kagi/driver-sesame` | SESAME Web API |
| `@kagi/auth-oidc` | OIDC sign-in (code + PKCE, encrypted session cookie) and bearer-JWT auth for the API |
| `@kagi/auth-clerk` | Optional: sign-in with Clerk's SDK and hosted Account Portal |
| `@kagi/server` | The Hono app: door page, unlock route, optional API |
| `apps/server` | Entrypoint with config from env, and the Dockerfile for Cloud Run |

## Run the server locally

1. Register an OIDC client at your provider with the redirect URI `http://localhost:8080/auth/callback`
   (Pocket ID: a public client with PKCE is fine).
2. Put yourself in a group named `door:home` and make sure the client receives the `groups` claim.
3. Fill in `.env` from `.env.example` (`OIDC_*`, `KAGI_SESSION_SECRET`, `KAGI_DOORS`), then:

```sh
bun run dev
open http://localhost:8080/d/home
```

Configuration is environment variables only; `.env.example` lists them all. Build the container with
`docker build -t kagi .` (a single compiled binary on distroless).

## Try a lock from the terminal

Requires [Bun](https://bun.sh).

```sh
bun install
cp .env.example .env    # fill in your credentials
bun run probe sesame state
bun run probe sesame unlock     # goes through the Gate: unlock, then re-read the state
bun run probe switchbot devices # list device ids on your SwitchBot account
```

## Development

```sh
bun test
bun run typecheck
```

End-to-end tests run the real sign-in against a throwaway [Pocket ID](https://pocket-id.org) in Docker
(the released image; admin API via `STATIC_API_KEY`, sign-in via one-time access links, so no
passkey is needed) and drive headless Chromium through the door page. Only the lock is faked.

```sh
bunx playwright install chromium   # once
bun run e2e
```

## Disclaimer

KAGI controls physical locks. It is provided **as is, without warranty** (see [LICENSE](LICENSE)).
Keep a physical way in and out that does not depend on KAGI, the vendor's cloud, or your network.

KAGI is not affiliated with or endorsed by SwitchBot (Wonderlabs, Inc.) or CANDY HOUSE, Inc.
Product names are used only to describe compatibility. Use of each vendor's API is subject to
that vendor's terms, which you accept with your own account and API keys.

## License

[MIT](LICENSE)
