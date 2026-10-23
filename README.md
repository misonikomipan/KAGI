# KAGI — Keyless Access Gate Interface

Tap an NFC tag at the door, sign in, press **Unlock**, and the smart lock opens.

- The NFC tag only carries a URL; it is never the key. Every decision is made server-side.
- Opening the URL never unlocks anything — only the button (a POST) does.
- Smart-lock vendors are pluggable `LockDriver`s. Built in: **SwitchBot** (Lock / Lock Pro / Lock Ultra …) and **SESAME** (via Hub3 / Wi-Fi Module 2).
- No database: doors are configuration, people live in the identity provider (Clerk), and the audit trail is JSON lines on stdout.

See [docs/design.md](docs/design.md) for the interfaces and the reasoning behind them.

> **Status:** early development. The core and both drivers are implemented and unit-tested; the web app (Hono + Clerk on Cloud Run) is next.

## Packages

| Package | Contents |
| --- | --- |
| `@kagi/core` | Types, `createGate()`, built-in authorizers, stdout audit sink |
| `@kagi/driver-switchbot` | SwitchBot OpenAPI v1.1 |
| `@kagi/driver-sesame` | SESAME Web API |

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

## Disclaimer

KAGI controls physical locks. It is provided **as is, without warranty** (see [LICENSE](LICENSE)).
Keep a physical way in and out that does not depend on KAGI, the vendor's cloud, or your network.

KAGI is not affiliated with or endorsed by SwitchBot (Wonderlabs, Inc.) or CANDY HOUSE, Inc.
Product names are used only to describe compatibility. Use of each vendor's API is subject to
that vendor's terms, which you accept with your own account and API keys.

## License

[MIT](LICENSE)
