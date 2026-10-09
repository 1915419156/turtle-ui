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

## Interaction

The prompt status line reads left to right as one sentence about the session: working directory and branch, model, reasoning effort, un-cached/cached input and output tokens with the KV-cache hit rate, the live output rate in tokens per second while a step streams, and the share of the context window in use. Every fragment is a registered prompt value (`${model}`, `${reasoning}`, `${throughput}`, `${context}`, …), so a deployment can rearrange or drop any of them through `theme.leftPrompt` / `theme.rightPrompt`, and plugins can register their own.

- `@` completes workspace paths; `@` followed by a path in a submitted prompt is announced to the model as an explicit file reference.
- Up/Down walk submitted prompts; **Ctrl+R** opens a fuzzy search over the prompts submitted in this process, and Enter inserts the selection back into the editor without sending it. The retained list is bounded by `historySize`.
- **Ctrl+O** cycles tool-card visibility (collapsed → expanded → hidden); **Ctrl+T** toggles reasoning blocks; **Ctrl+L** repaints after terminal corruption.
- `/locale [en|zh|auto]` shows or switches the interface language; the change applies to the whole session at once.
- **Double Esc** on an idle agent opens the rewind/fork picker. Each row is a restore point — the end of a completed turn, or the current end of the log to branch without discarding anything. Choosing one forks the session: the child inherits exactly that prefix of the log (an open tail is closed with synthetic forked results), is persisted under its own id, and is opened by the launcher in the same workspace. The source session is never modified, so a fork is always safe to repeat. Without a launcher the gesture reports that the host cannot hand off.

`/render rich|plain` switches the transcript between parsed Markdown and verbatim text. Both modes receive the same escaped content, so the switch changes presentation only; plain mode is the useful choice when a terminal's own scrollback search matters more than formatting. The switch applies to a step that is still streaming — its live text is carried across the rebuild rather than waiting for the step to settle.

## Operations

- `/doctor` prints a self-check card: runtime (Node, platform, cores, memory, disk), session facts, the model route and whether a price table covers it, every optional service the TUI reads — including the `sessionProjections` registry, the `loader`, and the launcher-provided resume host — reporting explicitly when one is not mounted, and the active presentation state. Rows that indicate a reduced composition are summarized as warnings.
- `/cost` reports token totals per bucket, the cache hit rate, and step count, plus an estimated spend when `prices` configures one. A price entry requires `input` and `output`; `provider`/`model` default to matching any route and `cacheRead`/`cacheWrite` default to the input price, so `{ model: "*", input: 0.27, output: 1.1 }` is a valid catch-all. Prices are deployment configuration, not provider-reported figures; `/cost --json` emits the same numbers for tooling.
- `/mcp` lists the MCP servers whose tools are registered, grouped by the `mcp__<server>__<tool>` names they contribute, with each tool's description.
- `/export [--md|--jsonl] [path]` writes the session log to a file — a reading transcript or the durable event stream — defaulting to a timestamped name in the session workspace.
- `/btw <question>` asks a one-shot model call outside the session log: neither the question nor the answer becomes model history, and the reply streams into its own transcript card, so a side question is available even mid-turn. Its `recordInput: false` registration keeps the question text out of the durable log as well.

## Languages

The terminal ships English and Chinese and renders in whichever the process environment asks for: `locale: auto` (the default) reads `LC_ALL`, then `LC_MESSAGES`, then `LANG`, and takes a `zh` primary subtag as Chinese, everything else as English. `locale: en|zh` pins one. `/locale` reports the active language and switches it — `en`, `zh`, or `auto` to hand the choice back to the environment — and the whole session repaints immediately, command descriptions and slash autocomplete included. Two strings deliberately stay outside the dictionaries because their owner is the deployment rather than the interface: `theme.inputPlaceholder`, when a deployment sets one, and the exit line a launcher supplies through `tuiGoodbyeMessage` — the launcher is the only side that knows how it was invoked, so it owns that wording in every language.

`zh` owns the translation key set and `en` is checked complete against it at compile time, so the two cannot drift. An entry is a function where a language needs grammar a `{placeholder}` cannot express, which is how English pluralizes a count while Chinese does not. The shipped surface is exported for embedders:

```ts
import { createTranslator, resolveLocale, LOCALE_IDS } from '@deepseek-ai/dsh-tui/i18n'

const { t } = createTranslator(resolveLocale('auto'))
t('count.toolCall', { count: 2 })   // '2 tool calls' or '2 次工具调用'
```

## Themes

`/theme dark|light` pins the palette when a terminal does not report its color scheme (or reports one you disagree with), `/palette` prints every color and attribute role the interface is allowed to emit, and `/details` jumps tool-card visibility and reasoning display to named states directly.

The window opens on the product line and the session identity — no startup animation, no artwork to dismiss — so the first thing on screen is the transcript and the prompt.

## Checks

```sh
pnpm run typecheck
pnpm test
pnpm run build
```

