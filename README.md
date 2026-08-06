# Turtle UI

> The very first UI of dsh in a Friday afternoon

This repository contains the former `packages/ui/tui` implementation, its unit and terminal snapshot tests, and a dsh profile bundle patch. The TUI owns terminal presentation and input; DeepSeek Harness owns the agent, model, tools, persistence, and `dsh` launcher.

## Development

Keep this repository and DeepSeek Harness as siblings:

```text
~/git/deepseek-harness
~/git/turtle-ui
```

Install and build Turtle UI:

```sh
pnpm install
pnpm run build
```

The peer APIs come from the sibling Harness checkout. The standalone TypeScript and Vitest configurations intentionally resolve those sources through `../deepseek-harness`. The patched `@earendil-works/pi-tui` is a devDependency bundled into `lib/` at build time, so consumers install no pi-tui and need no `patchedDependencies`.

## Run

Turtle UI is a dsh profile bundle: its `package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`, so installing it into a profile activates the patch layer automatically.

From a local checkout (the development loop — `link:` picks up rebuilds without reinstalling):

```sh
dsh plugin --profile tui add link:~/git/turtle-ui
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

The bundle layer rides over `@deepseek-ai/dsh-base` and binds the TUI and configured agent to the durable session id `main`. It does not restore the removed TUI-specific CLI launcher, so launcher-owned `/resume` handoff and exit-message behavior are unavailable.

## Checks

```sh
pnpm run typecheck
pnpm test
pnpm run build
```
