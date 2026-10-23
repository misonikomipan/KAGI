# Architecture (C4)

`index.html` is an interactive C4 diagram of KAGI at four levels: system context, containers, the
KAGI server's components, and the code inside each component. Open it in a browser; click an
element to see where in the source it was found, double-click (or "Zoom in") to go one level down.

It is generated from the source, not drawn by hand:

```sh
bun docs/architecture/analyze.ts                            # the working tree
bun docs/architecture/analyze.ts --base main                # ... and what changed since main
bun docs/architecture/analyze.ts --base main --head HEAD    # two commits (e.g. a pull request)
```

It writes `model.json` and `index.html` (from `template.html`).

## Reviewing a change

With `--base`, the base commit is exported with `git archive` and analyzed the same way (workspace
packages resolve to that commit's sources). Elements are matched by id and shown as **added**
(green), **removed** (red, dashed) or **changed** (purple; the old label or condition is listed).
Each level tab shows its counts, the side panel lists the changes, and **Changes only** fades the
rest. Ids do not contain line numbers, so moving code around does not show up as a change.

## What the analysis finds

`analyze.ts` uses the TypeScript type checker (ts-morph), not just imports:

| Element | How it is found |
| --- | --- |
| Containers | Entry files under `apps/*/src` and `scripts/` that nothing imports; `Bun.serve` → server, `process.argv` → CLI. Their files are what the entry reaches through imports. |
| Components | Hono route registrations (`app.get/post/all(...)`), and functions whose **return type** is a port interface from `packages/core/src/types.ts` (`LockDriver`, `Authenticator`, `Authorizer`, `AuditSink`, `Gate`). Functions that call those factories become composition roots. |
| Component → component | A call through a port method (e.g. `opts.authenticator.authenticate`) is resolved to the implementations that are actually wired in that container, narrowed by slot name (`authenticator` vs `api`). The `if` / `?:` / `??` around each wiring site becomes the edge's condition. |
| Component → external | Network calls of known libraries (`openid-client`, `jose.createRemoteJWKSet`, `@clerk/backend`), `https://` literals (SESAME, SwitchBot), `fetch` to a configured URL, and `console.log` (audit stream). |
| Code | Functions reachable from each component (declarations, arrow functions, class methods, constructors) and what they call, with every edge pointing at a file and line. |

Hand-added (shown dashed amber): people, the physical locks, and "Other apps" calling the API.
They are not visible in code.

## Known limits

- Slot matching is by name. `rules[0]` flowing into `authorizer` when there is only one rule is not
  traced, so the gate's link to `claimAllowList` appears through `allOf` only.
- Library-to-external mapping (`NETWORK_CALLS`, `EXTERNAL_NAMES` in `analyze.ts`) is a table:
  the analysis decides whether an edge exists, the table only names the far end.
