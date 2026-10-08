# Turtle UI

> The very first UI of dsh in a Friday afternoon

This repository contains the former `packages/ui/tui` implementation, its unit and terminal snapshot tests, and a dsh profile bundle patch. The TUI owns terminal presentation and input; DeepSeek Harness owns the agent, model, tools, persistence, and `dsh` launcher.

## Development

Keep this repository and DeepSeek Harness as siblings:

```text
~/git/deepseek-harness
~/git/turtle-ui
```

Install and build the sibling Harness, then Turtle UI:

```sh
(cd ../deepseek-harness && pnpm install && pnpm run build)
pnpm install
pnpm run build
```

The peer APIs come from the sibling Harness checkout. The standalone TypeScript and Vitest configurations intentionally resolve those sources through `../deepseek-harness`; Vitest uses the Harness build for the goal host module instead of mixing that source module with transitive built packages. The patched `@earendil-works/pi-tui` is a devDependency bundled into `lib/` at build time, so consumers install no pi-tui and need no `patchedDependencies`.

## Run

Turtle UI is a dsh profile bundle: its `package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, so installing it into a profile activates the patch layer automatically.

From a local checkout, build and install a copied `file:` package so its Harness peers resolve through the profile's managed fallback. Re-run the add after rebuilding to refresh the copy:

```sh
pnpm run build
dsh plugin --profile tui add file:.
dsh --profile tui
```

From git, with no checkout: the `prepare` script transpiles `lib/` on the consumer's machine during install. pnpm ≥10 blocks that build until you allow it, so the first `add` fails with an `allowBuilds` hint; copy the exact key pnpm prints into the profile's `pnpm-workspace.yaml` and re-run:

```sh
dsh plugin --profile tui add github:deepseek-harness/turtle-ui   # fails with the allowBuilds key
# add the printed key under allowBuilds in ~/.dsh/profiles/tui/pnpm-workspace.yaml
dsh plugin --profile tui add github:deepseek-harness/turtle-ui   # builds and activates
dsh --profile tui
```

The `prepare` build (`tsdown.prepare.config.ts`) transpiles without type checking — the repo's type graph needs the sibling harness checkout, which consumers don't have. `pnpm run typecheck` in a sibling-checkout environment remains the type gate.

The bundle layer rides over `@deepseek-ai/dsh-base` and binds the TUI and configured agent to one durable session. The ordinary `tui-startup` provider injects the launcher's immutable `ctx.cmdlineArgs`, parses `--resume`, `--session`, `--skill`, and this app's `--help`, then provides `tuiStartup`; session-bound rows inject that service and read it from lazy config, so they cannot activate on the wrong session. A bare `dsh --profile tui` mints a fresh session id on every launch, `--session <id>` names a fresh session explicitly, `--resume <session>` continues a persisted session, and `--skill <name>` seeds a fresh session's first turn with `/skill:<name>`.

The same provider publishes the launcher-side host facts the terminal reads. When the process was booted by `dsh` (a `profileContext` is present), it derives an in-place resume host from the booted dsh package's own `bin` entry — `/resume` re-execs `dsh --profile <profile> --resume <session>` in the selected session's workspace, and `/new` re-execs a bare `dsh --profile <profile>` there — plus the exit line naming that command. Both are simply absent when the app is mounted without a launcher, so `/resume` reports that the host cannot hand off, and a `--skill` value still seeds the first turn because it needs no launcher. The terminal answers the `approval/request` waterfall too: when the base's `dsh-user-approval` (policy `ask`) asks about a tool call, the TUI presents an inline Allow once / Reject panel, and every path that cannot ask — shutdown, a prompt that cannot mount — resolves to a non-granting outcome so the tool pipeline fails closed exactly as it would with no answerer composed.

Session management spans the picker's three scopes. `/resume` opens on this workspace, Tab cycles to all workspaces and to `archived`, Ctrl+N starts a fresh session in place, and Ctrl+D in the first two scopes hides the selected session through the workspace registry's durable archive set. Removal is archival by design — the harness has no hard delete; an archived session's log stays intact, disappears from the ordinary scopes, and is restored with Ctrl+D from the `archived` scope (`/resume --archived` opens it directly). Without the registry row the archived scope and Ctrl+D simply do not exist, and the picker says so rather than pretending.

## Checks

```sh
pnpm run typecheck
pnpm test
pnpm run build
```
