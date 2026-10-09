/**
 * Interactive pi-tui front door for DeepSeek Harness agents. It renders the
 * durable session transcript, drives one configured agent, and provides
 * keyboard-driven user-questions dialogs without owning agent lifecycle.
 * @module @deepseek-ai/dsh-tui
 */

import {
  CombinedAutocompleteProvider,
  Container,
  Key,
  Spacer,
  Text,
  TUI,
  ProcessTerminal,
  matchesKey,
  visibleWidth,
  type Component,
  type EditorTheme,
  type SlashCommand,
  type TerminalColorScheme,
} from '@earendil-works/pi-tui'
import { Service, type Context, type Fiber, type FiberState } from '@deepseek-ai/cordis'
import {
  assembleContextFor,
  installModelSelection,
  type Agent,
  type ModelSelectionRef,
  type AgentStatus,
} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-llm-retry'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  isReplacementSurfaceEvent,
  SessionId,
  type SessionEvent,
  type UserMessage,
} from '@deepseek-ai/dsh-session'
// Type import declaration-merges the `todo/write` session event the todo tool
// appends (and its `TodoItem` payload) into the event maps this file switches on.
import type {} from '@deepseek-ai/dsh-tool-todo'
import { foldGoal } from '@deepseek-ai/dsh-goal'
import {
  parseSessionReferenceText,
} from '@deepseek-ai/dsh-session-reference'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
// Type import also declaration-merges the optional `sessionPersistence`
// service onto `Context` so `ctx.get('sessionPersistence')` is typed.
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { SkillRegistry } from '@deepseek-ai/dsh-skill'
// Type import declaration-merges the `userQuestions` service onto `Context`;
// the ask-user-question queue is registered by ./chat/questions.
import type {} from '@deepseek-ai/dsh-user-questions'
// Type import declaration-merges the `approval/request` waterfall and the
// `approval/asked`/`approval/decided` audit events; the approval answerer is
// registered by ./chat/approval. Both seams are optional compositions, so the
// package stays an optional peer and the queue is inert without them.
import type {} from '@deepseek-ai/dsh-user-approval'
import {
  TuiExtensionServiceImpl,
  TuiOverlayManager,
} from './extension/overlay-manager.ts'

import {
  parseTuiPromptTemplate,
  renderTuiPromptTemplate,
  type TuiPromptValueHandle,
} from './prompt.ts'
import type {
  TuiOverlayRequest,
  TuiOverlaySession,
  TuiTheme,
} from './extension/types.ts'
import { displayInlineText, displayText } from './components/text.ts'
import {
  createTranslator,
  isLocaleSetting,
  LOCALE_IDS,
  LOCALE_LABELS,
  retargetTranslator,
  resolveLocale,
  type LocaleId,
  type LocaleSetting,
  type Translator,
} from './i18n/translate.ts'
import { brandText, createPalette, markdownTheme, renderPalette, selectTheme } from './components/theme.ts'
import { contentText, parseArguments } from './components/content.ts'
import { isRenderMode, renderModeLabel, type RenderMode } from './components/prose.ts'
import { HistorySearchDialog } from './components/history-search.ts'
import { InputHistory } from './chat/history.ts'
import { ThroughputTracker, outputCharacters, formatThroughput } from './chat/throughput.ts'
import { createDiagnosticsController } from './chat/diagnostics.ts'
import {
  defaultExportName,
  exportSession,
  resolveExportPath,
  type ExportFormat,
} from './chat/export.ts'
import { askSideQuestion } from './chat/btw.ts'
import { AsideAnswerComponent } from './components/aside.ts'
import { createRewindController, DOUBLE_ESCAPE_WINDOW_MS } from './chat/rewind-controller.ts'
import {
  cacheHitRate,
  formatTokens,
  recordEventUsage,
  sessionTokens,
} from './chat/tokens.ts'
import {
  fadeGlyph,
  formatQueuedStatus,
  formatStatusDuration,
  openTurn,
  pulseLevel,
  runningPhaseGlyph,
  STATUS_ANIMATION_INTERVAL_MS,
  STATUS_FADE_MS,
  StepTimingTracker,
  TIMING_BUCKET_GLYPHS,
  type StepPosition,
} from './chat/timing.ts'
import {
  resolveTuiConfig,
  type Config,
} from './config.ts'
import {
  ContextCardComponent,
  type ToolCardVisibility,
  HeaderComponent,
  StreamingAssistantComponent,
  ToolCardComponent,
  TodoComponent,
  UserMessageComponent,
} from './components/transcript.ts'
import {
  compactTargetLabel,
  DetailsDialog,
  diagnosticMeter,
  formatDiagnosticCount,
  formatDiagnosticNumber,
  formatDiagnosticTime,
  initialTarget,
  StatusCardComponent,
  PromptContextComponent,
  targetLabel,
  type DetailsSelection,
  type StatusCardRow,
} from './components/dialogs.ts'
import {
  parseSkillCommand,
  renderSkillInvocation,
  SKILL_COMMAND_PREFIX,
} from './chat/skill-invocation.ts'
import { ReferenceAutocompleteProvider } from './chat/autocomplete.ts'
import {
  BANNER_REVEAL_INTERVAL_MS,
  BANNER_REVEAL_STEPS,
  formatCwd,
  gitBranch,
  HintEditor,
  isCompactCheckpoint,
  sessionReferenceCard,
  transcriptToolCallIds,
} from './chat/helpers.ts'
import {
  createModelController,
  type ModelController,
} from './chat/model-command.ts'
import { createQuestionQueue } from './chat/questions.ts'
import { createApprovalQueue } from './chat/approval.ts'
import { createResumeController } from './chat/resume.ts'
import type { TuiResumeHost, TuiRuntime } from './runtime.ts'
import { WorkspaceFileSearch } from './chat/file-autocomplete.ts'

export { TuiPromptService } from './prompt.ts'
export { renderSkillInvocation } from './chat/skill-invocation.ts'
export type { TuiResumeHost, TuiRuntime } from './runtime.ts'
export {
  resolveTuiConfig,
  TuiConfigSchema,
  Config,
  type ResolvedTuiConfig,
  type ResolvedTuiThemeConfig,
  type TuiConfig,
  type TuiThemeConfig,
} from './config.ts'
export {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
} from './chat/file-autocomplete.ts'

export type {
  TuiComponent,
  TuiFocusable,
  TuiOverlayAnchor,
  TuiOverlayCloseReason,
  TuiOverlayHost,
  TuiOverlayMargin,
  TuiOverlayOptions,
  TuiOverlayOutcome,
  TuiOverlayRequest,
  TuiOverlaySession,
  TuiOverlayState,
  TuiTheme,
  TuiViewport,
} from './extension/types.ts'

/** First terminal Cordis state: FAILED, DISPOSED, and UNLOADING are unusable. */
const FIBER_FAILED = 3 as FiberState.FAILED

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Terminal-only interaction service, available only while a TUI is mounted. */
    tui: TuiExtensionService
    /** Optional process host that can replace this TUI with a resumed session. */
    tuiResumeHost: TuiResumeHost
    /** Launcher-owned `main` session identity; absent lets the app mint one. */
    mainSessionId: MainSessionIdentity | undefined
    /** Line the launcher wants printed on exit; absent prints nothing. */
    tuiGoodbyeMessage: string | undefined
    /** Skill the launcher wants auto-invoked as the fresh session's first turn; absent leaves it to the user. */
    tuiInitialSkill: string | undefined
  }
}

/** Launcher-chosen identity for the app's `main` session. */
export interface MainSessionIdentity {
  /** Exact session id `main` binds to. */
  readonly id: SessionId
  /**
   * Whether that session already has persisted history to load. `true` requires
   * an existing log and fails loud when absent; `false` creates it fresh.
   */
  readonly resume: boolean
}

/**
 * Context key a launcher sets before any Loader entry mounts
 * (`ctx.provide(MAIN_SESSION_ID_KEY, identity)`) to fix the `main` agent's
 * session identity, so an app bundle mounted from a `cordis.yml` binds a
 * launcher-selected session without a config key. `ctx.provide` is the only
 * channel from launcher argv into a Loader-mounted plugin, because config
 * `!!js` expressions evaluate against the entry's context. Absent leaves the
 * choice to the app.
 */
export const MAIN_SESSION_ID_KEY = 'mainSessionId'

// The launcher-side host keys are declared once in ./host-keys so this reader
// and the startup provider that supplies them cannot drift; re-exported here
// for consumers that import them from the package entry.
export {
  INITIAL_SKILL_KEY,
  TUI_GOODBYE_MESSAGE_KEY,
  TUI_RESUME_HOST_KEY,
} from './host-keys.ts'

/**
 * Optional terminal-local interaction service provided by one mounted TUI.
 *
 * The concrete provider retains pi-tui, focus, and terminal lifecycle state.
 * Plugins receive only effect-owned overlay sessions.
 */
export abstract class TuiExtensionService extends Service {
  /** Exact agent driven by this terminal instance. */
  abstract readonly agent: Agent

  /**
   * Queue an interactive overlay owned by the calling plugin fiber.
   *
   * The TUI displays one overlay at a time in FIFO order. Disposing the caller
   * removes a queued overlay or closes an active one before plugin teardown
   * settles. This live presentation is neither logged nor replayed.
   *
   * @param request - component factory, layout constraints, and cancellation.
   * @returns the effect-owned overlay session.
   * @throws when the TUI has begun shutting down.
   */
  abstract openOverlay(request: TuiOverlayRequest): TuiOverlaySession
}

export const name = 'ui-tui'
export const inject = ['agents', 'sessions', 'commands', 'userQuestions', 'tools', 'llm', 'systemPrompt', 'tokenMeter', 'tuiPrompt']

/** Model guidance for path-only file references selected through the TUI. */
export const FILE_REFERENCE_PROMPT = 'Paths prefixed with @ are files explicitly referenced by the user. Use the read tool when their contents are needed; do not claim to have inspected a file before reading it.'

interface RunningStatus {
  turn: number | undefined
  timer: ReturnType<typeof setInterval>
  /** Render clock when the turn began; origin of the glyph fade-in. */
  startedAt: number
  /** The most recently rendered phase glyph, handed to the fade-out. */
  lastGlyph: string
}

/** A running glyph fading out after its turn ended, before the caret returns. */
interface FadingStatus {
  glyph: string
  /** Render clock when the turn ended; origin of the glyph fade-out. */
  endedAt: number
  timer: ReturnType<typeof setInterval>
}

/** Width/height adapter for a modal component rendered inside the base TUI flow. */
class InlineModalComponent extends Container {
  constructor(
    component: Component,
    private readonly width: number,
    private readonly maxHeight: number,
  ) {
    super()
    this.addChild(component)
  }

  override render(width: number): string[] {
    const lines = super.render(Math.max(1, Math.min(width, this.width)))
    return lines.slice(0, Math.max(1, this.maxHeight))
  }
}

/** Lifecycle handle for a mounted interactive terminal channel. */
export interface TuiController {
  /** Stop rendering, restore the terminal, and reject pending questions. */
  dispose(): Promise<void>
}

/**
 * Start the interactive pi-tui channel for an already-created target agent.
 * @param ctx - agent, tools, session-event, and user-questions context.
 * @param config - target agent, banner, and TUI presentation config.
 * @param runtime - terminal and process-exit boundary.
 * @returns lifecycle controller used by the Cordis effect disposer.
 */
export function createTuiChat(
  ctx: Context,
  config: Config,
  runtime: TuiRuntime,
): TuiController {
  const sessionId = SessionId(config.sessionId ?? 'main')
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error(`ui-tui: session "${sessionId}" is not running`)
  const resolved = resolveTuiConfig(config)
  // An explicitly configured placeholder is deployment copy and wins in every
  // language; absent one, the prompt hint follows the interface language.
  const configuredPlaceholder = config.theme?.inputPlaceholder
  // One translator per channel: `/locale` swaps the whole object, and every
  // component holds this same reference, so a switch repaints every surface
  // through a single rebuild rather than re-plumbing each sub-controller.
  const translator: Translator = createTranslator(resolved.locale)
  const t = (key: Parameters<Translator['t']>[0], params?: Parameters<Translator['t']>[1]): string =>
    translator.t(key, params)
  const palette = createPalette(resolved.theme.color)
  const mdTheme = markdownTheme(palette)
  const ui = new TUI(runtime.terminal, resolved.showHardwareCursor)
  const chat = new Container()
  const todoContainer = new Container()
  const questionContainer = new Container()
  const inputTemplate = parseTuiPromptTemplate(displayInlineText(resolved.theme.inputPrompt))
  const renderInputPrompt = (): string => renderTuiPromptTemplate(inputTemplate, valueName => ctx.tuiPrompt.get(valueName))
  const initialInputPrompt = renderInputPrompt()
  const editor = new HintEditor(ui, {
    borderColor: palette.dim,
    selectList: selectTheme(palette),
  } satisfies EditorTheme, {
    paddingX: 1,
    frame: 'none',
    prompt: {
      first: initialInputPrompt,
      continuation: ' '.repeat(visibleWidth(initialInputPrompt)),
    },
  })
  editor.hintPrefix = initialInputPrompt
  const todo = new TodoComponent(palette, translator)
  const compactionStatusLine = new Text('', 0, 0)
  let showReasoning = resolved.showReasoning
  // Ctrl+O cycles collapsed -> expanded -> hidden. Codex-style: hidden drops
  // tool cards entirely, collapsed previews, expanded shows full bodies.
  let toolsVisibility: ToolCardVisibility = 'collapsed'
  let streaming: StreamingAssistantComponent | undefined
  let completedStreaming: StreamingAssistantComponent | undefined
  // One shared accumulator serves every step's timing footer; per-footer
  // replay of the whole log is quadratic on a long resumed session.
  const stepTimingTracker = new StepTimingTracker()
  // Assistant step components in model order per turn, for hidden-mode folding:
  // with tool cards hidden, a turn keeps one Assistant header and later steps
  // render as headerless continuations (see applyTurnFolding).
  const assistantSteps = new Map<number, StreamingAssistantComponent[]>()
  let runningStatus: RunningStatus | undefined
  let fadingStatus: FadingStatus | undefined
  /**
   * Live standalone compaction observed by this process. Never derive this
   * state from history: a resumed log may contain a stale orphaned start.
   */
  let compacting: {
    startedAt: number
    timer: ReturnType<typeof setInterval>
  } | undefined
  // TUI steering submissions that the inbox has not yet claimed or discarded.
  // Correlation ids avoid guessing whether a running-state submission actually
  // joined steering or fell back to the queued-turn FIFO during turn close.
  const pendingSteering = new Set<MessageId>()
  /** Render clock of the last unarmed Escape, for the double-Esc rewind gesture. */
  let lastEscapeAt: number | undefined
  let disposed = false
  let shuttingDown: Promise<void> | undefined
  // Optional: skills mount conditionally, so read the global service store
  // rather than declaring an injection that would make the TUI require them.
  const skills = ctx.get('skills')
  const cwd = agent.session.header.cwd ?? process.cwd()
  const fileSearch = new WorkspaceFileSearch(cwd, {
    maxResults: resolved.fileSearchMaxResults,
    maxEntries: resolved.fileSearchMaxEntries,
    excludedDirectories: resolved.fileSearchExcludedDirectories,
  })
  const skillAbort = new AbortController()
  const tokens = sessionTokens(agent.session)
  const toolCards = new Map<string, ToolCardComponent>()
  const allToolCards = new Set<ToolCardComponent>()
  const contextCards = new Set<ContextCardComponent>()
  // Side-question answers are session-log-free presentation, but their cards
  // still follow the transcript's render mode and reasoning toggle.
  const asideCards = new Set<AsideAnswerComponent>()
  const liveErrorTurns = new Set<number>()
  const commandControllers = new Set<AbortController>()
  const referenceControllers = new Set<AbortController>()
  let tuiServiceFiber: Fiber | undefined
  const target: ModelSelectionRef = { current: initialTarget(agent), assembled: undefined }
  // `updatePromptValues` (defined below) closes over the model controller, but
  // the controller needs `appendNotice`/`overlayManager`, defined after that
  // closure. Declare here, assign once after those exist, and defer the first
  // `updatePromptValues()` call until after the assignment so no read precedes it.
  // oxlint-disable-next-line prefer-const -- single assignment is a forward-reference, not a const.
  let modelController!: ModelController
  const now = (): number => runtime.now?.() ?? Date.now()
  const agentStatus = (): AgentStatus => agent.status
  const isDisposed = (): boolean => disposed

  // A configured subtitle renders as a banner line; when absent, the banner has
  // no subtitle. The banner itself sweeps in on start (see startBannerReveal).
  let sessionTitle = foldSessionTitle(agent.session.snapshotEvents())?.title
  const header = new HeaderComponent(
    agent,
    () => sessionTitle ?? config.welcome,
    palette,
    resolved.theme.color && resolved.theme.truecolor,
  )
  const formattedCwd = displayText(runtime.formatCwd?.(agent.session.header.cwd)
    ?? formatCwd(agent.session.header.cwd, t))
  const branch = runtime.gitBranch?.(cwd) ?? gitBranch(cwd)
  // Prompt history and live throughput: both are terminal-local presentation
  // state, so neither touches the session log.
  const history = new InputHistory(resolved.historySize)
  const throughput = new ThroughputTracker()
  const promptValues: TuiPromptValueHandle[] = [
    ctx.tuiPrompt.register('cwd', palette.bold(palette.accent(formattedCwd))),
    ctx.tuiPrompt.register('git/worktree', branch === undefined ? undefined : palette.dim(` (${displayText(branch)})`)),
    ctx.tuiPrompt.register('token_meter/cache_hit_rate'),
    ctx.tuiPrompt.register('model'),
    ctx.tuiPrompt.register('context'),
    ctx.tuiPrompt.register('queued'),
    ctx.tuiPrompt.register('throughput'),
    ctx.tuiPrompt.register('reasoning'),
    ctx.tuiPrompt.register('symbol', palette.bold(palette.accent('dsh'))),
    ctx.tuiPrompt.register('indicator', palette.dim('> ')),
  ]
  const [
    cwdValue, gitValue, tokenValue, modelValue, contextValue,
    queuedValue, throughputValue, reasoningValue, symbolValue, indicatorValue,
  ] = promptValues
  /* v8 ignore next -- the fixed built-in registration list always supplies each handle. */
  if (cwdValue === undefined || gitValue === undefined || tokenValue === undefined || modelValue === undefined
    || contextValue === undefined || queuedValue === undefined || throughputValue === undefined
    || reasoningValue === undefined || symbolValue === undefined || indicatorValue === undefined) {
    throw new Error('TUI prompt built-ins failed to initialize')
  }
  const updatePromptValues = (): void => {
    const renderTime = now()
    cwdValue.set(palette.bold(palette.accent(formattedCwd)))
    gitValue.set(branch === undefined ? undefined : palette.dim(` (${displayText(branch)})`))
    const rate = cacheHitRate(tokens)
    const usage = `↑${formatTokens(tokens.input)} ↓${formatTokens(tokens.output)}`
    modelValue.set(`  ${palette.dim(displayText(target.current === undefined
      ? t('prompt.modelUnset')
      : compactTargetLabel(target.current)))}`)
    tokenValue.set(`  ${palette.dim(rate === undefined ? usage : `${usage}  cache ${rate}%`)}`)
    const contextWindow = modelController.contextWindow()
    contextValue.set(contextWindow === undefined ? undefined : `  ${palette.dim(
      `${Math.min(100, Math.round(ctx.tokenMeter.measure(agent.session).totalTokens / contextWindow * 100))}% context`,
    )}`)
    const queued = runningStatus === undefined ? undefined : formatQueuedStatus(pendingSteering.size, t)
    queuedValue.set(queued === undefined ? undefined : palette.dim(queued))
    // Live output rate: only while a turn is running, so an idle prompt does not
    // keep advertising a rate from the previous turn.
    const tps = runningStatus === undefined ? undefined : throughput.tokensPerSecond(renderTime)
    throughputValue.set(tps === undefined ? undefined : palette.dim(`  ${formatThroughput(tps)}`))
    // The reasoning effort is part of the model's identity for a request, so it
    // belongs next to the model rather than only in `/status`.
    const effort = target.current?.reasoningEffort
    reasoningValue.set(effort === undefined ? undefined : palette.dim(`  effort ${displayText(effort)}`))
    symbolValue.set(palette.bold(palette.accent('dsh')))
    compactionStatusLine.setText(compacting === undefined
      ? ''
      : palette.dim(t('prompt.compacting', {
        duration: formatStatusDuration(renderTime - compacting.startedAt),
      })))
    // `${indicator}` owns the caret column and its trailing gap before the
    // cursor. The active status glyph replaces the `>` caret in place — same
    // width every frame — fading in when work starts, throbbing while it runs,
    // and fading out after it ends before the plain `>` returns. Only the gray
    // brightness changes, so the cursor never shifts.
    const statusGlyph = runningPhaseGlyph(
      stepTimingTracker.openPhase(agent.session.snapshotEvents()),
      runningStatus !== undefined,
      compacting !== undefined,
    )
    // Remember the live phase glyph so the fade-out shows it, not the ttft
    // fallback the derivation returns once the closing turn's step has ended.
    if (runningStatus !== undefined && statusGlyph !== undefined) runningStatus.lastGlyph = statusGlyph
    // The fade envelope gates appear/disappear; the active throb breathes the
    // glyph throughout the operation. Truecolor opacity is envelope × throb; the
    // non-truecolor fallback keys visibility off the envelope alone, so the
    // throb never blinks it. `envelope` clamps to [0, 1].
    const activeSince = runningStatus?.startedAt ?? compacting?.startedAt
    const envelope = activeSince !== undefined && statusGlyph !== undefined
      ? { glyph: statusGlyph, level: Math.min(1, (renderTime - activeSince) / STATUS_FADE_MS) }
      : fadingStatus !== undefined
        ? { glyph: fadingStatus.glyph, level: Math.max(0, 1 - (renderTime - fadingStatus.endedAt) / STATUS_FADE_MS) }
        : undefined
    const caret = envelope === undefined
      ? palette.dim('>')
      : fadeGlyph(
        envelope.glyph,
        palette,
        resolved.theme.color,
        resolved.theme.color && resolved.theme.truecolor,
        envelope.level * pulseLevel(renderTime),
        envelope.level >= 0.5,
      )
    indicatorValue.set(`${caret}${palette.dim(' ')}`)
  }
  const promptContext = new PromptContextComponent(
    parseTuiPromptTemplate(displayInlineText(resolved.theme.leftPrompt)),
    parseTuiPromptTemplate(displayInlineText(resolved.theme.rightPrompt)),
    valueName => ctx.tuiPrompt.get(valueName),
  )
  ui.addChild(header)
  ui.addChild(chat)
  ui.addChild(new Spacer(1))
  todoContainer.addChild(todo)
  ui.addChild(todoContainer)
  ui.addChild(compactionStatusLine)
  ui.addChild(promptContext)
  ui.addChild(questionContainer)
  ui.addChild(editor)
  ui.setFocus(editor)
  const updateTerminalTitle = (): void => {
    runtime.terminal.setTitle(displayText(
      sessionTitle === undefined ? resolved.title : `${sessionTitle} — ${resolved.title}`,
    ))
  }
  updateTerminalTitle()

  const requestRender = (): void => {
    if (disposed) return
    updatePromptValues()
    const inputPrompt = renderInputPrompt()
    editor.setPrompt({ first: inputPrompt, continuation: ' '.repeat(visibleWidth(inputPrompt)) })
    editor.hintPrefix = inputPrompt
    promptContext.invalidate()
    ui.requestRender()
  }
  // A prompt value that changes on its own schedule (e.g. a plugin-owned
  // `${custom}` fragment) redraws through the registry's coalesced notification;
  // built-ins are already covered by the state-change callers of requestRender.
  const disposePromptChanges = ctx.tuiPrompt.subscribe(requestRender)

  const appendNotice = (message: string, kind: 'info' | 'warning' | 'error' = 'info'): void => {
    const color = kind === 'error' ? palette.error : kind === 'warning' ? palette.warning : palette.dim
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(color(displayText(message)), 0, 0))
    requestRender()
  }

  const extensionTheme: TuiTheme = Object.freeze({
    text: (value: string) => palette.text(value),
    brand: (value: string) => resolved.theme.color
      ? resolved.theme.truecolor ? brandText(value) : palette.brand(value)
      : value,
    dim: (value: string) => palette.dim(value),
    accent: (value: string) => palette.accent(value),
    success: (value: string) => palette.success(value),
    warning: (value: string) => palette.warning(value),
    error: (value: string) => palette.error(value),
    bold: (value: string) => palette.bold(value),
  })
  const overlayManager = new TuiOverlayManager({
    viewport: () => Object.freeze({
      columns: runtime.terminal.columns,
      rows: runtime.terminal.rows,
    }),
    theme: () => extensionTheme,
    display: displayText,
    show: (component, options, placement) => {
      if (placement === 'overlay') {
        return ui.showOverlay(component, options === undefined
          ? undefined
          : {
            ...options,
            ...typeof options.margin === 'object'
              ? { margin: { ...options.margin } }
              : {},
          })
      }
      const modal = new InlineModalComponent(
        component,
        resolved.questionDialogWidth,
        resolved.questionDialogMaxHeight,
      )
      questionContainer.clear()
      questionContainer.addChild(modal)
      ui.setFocus(component)
      return {
        hide(): void {
          questionContainer.clear()
          ui.setFocus(editor)
        },
      }
    },
    invalidate: requestRender,
    reportError: (error) => {
      const message = errorChain(error)
      ctx.logger.warn(`ui-tui: overlay failed: ${message}`)
      /* v8 ignore next -- shutdown removes overlays before the terminal stops */
      if (disposed) return
      appendNotice(t('notice.overlayFailed', { error: message }), 'error')
    },
  })

  const disposeTargetListeners = installModelSelection(agent.ctx, target)

  modelController = createModelController({
    ctx,
    resolved,
    palette,
    overlayManager,
    target,
    translator,
    appendNotice,
    requestRender,
    isDisposed,
  })
  updatePromptValues()

  const renderStatus = (): void => {
    streaming?.invalidate()
    requestRender()
  }

  /** Stop the turn-phase running and fade-out timers and drop both states. */
  const clearTurnStatus = (): void => {
    if (runningStatus !== undefined) {
      clearInterval(runningStatus.timer)
      runningStatus = undefined
    }
    if (fadingStatus !== undefined) {
      clearInterval(fadingStatus.timer)
      fadingStatus = undefined
    }
    runtime.terminal.setProgress(compacting !== undefined)
  }

  /** Hard clear: drop every indicator, including a live compaction bracket. */
  const clearStatus = (): void => {
    if (compacting !== undefined) {
      clearInterval(compacting.timer)
      compacting = undefined
    }
    clearTurnStatus()
  }

  /**
   * Hand the last active glyph to a fade-out that re-renders until it settles
   * on the `>` caret, then stops its own timer. A hard clear (teardown) skips
   * this via {@link clearStatus}.
   */
  const beginFadeOut = (glyph: string): void => {
    clearTurnStatus()
    const fading: FadingStatus = {
      glyph,
      endedAt: now(),
      timer: setInterval(() => {
        if (now() - fading.endedAt >= STATUS_FADE_MS) clearTurnStatus()
        renderStatus()
      }, STATUS_ANIMATION_INTERVAL_MS),
    }
    fadingStatus = fading
  }

  const setStatus = (status: AgentStatus): void => {
    const priorTurn = runningStatus?.turn
    const fadeOutGlyph = status !== 'running' ? runningStatus?.lastGlyph : undefined
    if (status === 'running') clearTurnStatus()
    else if (fadeOutGlyph !== undefined) beginFadeOut(fadeOutGlyph)
    else clearTurnStatus()
    editor.borderColor = status === 'running' ? text => palette.accent(text) : text => palette.dim(text)
    editor.hint = status === 'running'
      ? palette.dim(displayInlineText(configuredPlaceholder ?? t('prompt.inputPlaceholder')))
      : undefined
    if (status === 'running') {
      const turn = priorTurn ?? openTurn(agent.session.snapshotEvents())
      const running: RunningStatus = {
        turn,
        startedAt: now(),
        // Seed with the current phase (ttft before the first step opens) so the
        // fade-out always has a glyph, even for a turn that ends before a render.
        lastGlyph: TIMING_BUCKET_GLYPHS[stepTimingTracker.openPhase(agent.session.snapshotEvents()) ?? 'ttft'],
        // Refresh every tick so the fading prompt phase glyph animates even
        // before the first token, when no streaming component exists yet.
        timer: setInterval(renderStatus, STATUS_ANIMATION_INTERVAL_MS),
      }
      runningStatus = running
      runtime.terminal.setProgress(true)
    }
    requestRender()
  }

  const refreshStatus = (): void => {
    renderStatus()
  }

  const parsedTool = (event: Extract<SessionEvent, { type: 'tool/call' }>): ToolCardComponent => {
    const parsed = parseArguments(event.data.arguments)
    const card = new ToolCardComponent(
      event.data.name,
      parsed,
      ctx.tools.get(event.data.name, agent),
      resolved.maxToolOutputLines,
      resolved.maxDiffEditLength,
      palette,
      mdTheme,
      renderMode,
      translator,
    )
    card.setVisibility(toolsVisibility)
    toolCards.set(event.data.callId, card)
    allToolCards.add(card)
    return card
  }

  /**
   * Re-derive hidden-mode folding for one turn: the first step with a visible
   * body owns the turn's single Assistant header, every other step renders as a
   * headerless continuation (empty ones render nothing). Any other visibility
   * restores the per-step headers.
   */
  const applyTurnFolding = (turn: number): void => {
    const steps = assistantSteps.get(turn)
    if (steps === undefined) return
    let headerSeen = false
    for (const step of steps) {
      if (toolsVisibility !== 'hidden') {
        step.setFoldedContinuation(false)
      } else if (!headerSeen && step.hasVisibleBody()) {
        headerSeen = true
        step.setFoldedContinuation(false)
      } else {
        step.setFoldedContinuation(true)
      }
    }
  }

  const registerAssistantStep = (component: StreamingAssistantComponent): void => {
    const steps = assistantSteps.get(component.position.turn) ?? []
    steps.push(component)
    assistantSteps.set(component.position.turn, steps)
    applyTurnFolding(component.position.turn)
  }

  const removeStreaming = (current: StreamingAssistantComponent | undefined): void => {
    if (current === undefined) return
    for (const child of [current, current.timing]) {
      const index = chat.children.indexOf(child)
      /* v8 ignore next -- streaming components and their timing footers are retained only while attached to the chat. */
      if (index >= 0) chat.children.splice(index, 1)
    }
    const steps = assistantSteps.get(current.position.turn)
    /* v8 ignore next -- every attached streaming component is registered in the fold map. */
    if (steps === undefined) return
    const index = steps.indexOf(current)
    /* v8 ignore next -- registration precedes attachment, so the component is present until this removal. */
    if (index < 0) return
    steps.splice(index, 1)
    // A retracted step may have owned the turn's hidden-mode header.
    applyTurnFolding(current.position.turn)
  }

  /**
   * Move the running step's timing footer to the tail of the chat so it trails
   * the tool cards the step just appended. A completed footer (its step ended,
   * so `streaming` is cleared) stays pinned where it is.
   */
  const trailStreamingTiming = (): void => {
    /* v8 ignore next -- every replayed tool event follows its step/start, so an open step always owns an attached footer here. */
    if (streaming === undefined) return
    const footer = streaming.timing
    const index = chat.children.indexOf(footer)
    /* v8 ignore next -- the open step's footer is attached to the chat whenever a tool event of that step renders. */
    if (index < 0) return
    chat.children.splice(index, 1)
    chat.addChild(footer)
  }

  const clearStreaming = (): void => {
    removeStreaming(streaming)
    streaming = undefined
  }

  const retractFailedStreaming = (): void => {
    removeStreaming(streaming ?? completedStreaming)
    streaming = undefined
    completedStreaming = undefined
  }

  const startAssistantStep = (position: StepPosition): void => {
    streaming = new StreamingAssistantComponent(
      position,
      () => agent.session.snapshotEvents(),
      stepTimingTracker,
      now,
      showReasoning,
      palette,
      mdTheme,
      renderMode,
      translator,
    )
    registerAssistantStep(streaming)
    chat.addChild(streaming)
    chat.addChild(streaming.timing)
  }

  const renderEvent = (
    event: SessionEvent,
    options: {
      addHistory: boolean
    },
  ): void => {
    switch (event.type) {
      case 'user/message': {
        // Injected context (plugin/goal source) renders as a dim context card,
        // not a human bubble; only a direct human prompt is a user message. The
        // boolean avoids narrowing `source`, so the label keeps its full union.
        const source = event.data.source
        if (source.kind !== 'user') {
          const references = sessionReferenceCard(event.data.source)
          if (references !== undefined) {
            chat.addChild(new Spacer(1))
            chat.addChild(new Text(palette.dim(t('transcript.referencedSessions', {
              list: references.map(displayText).join(', '),
            })), 0, 0))
            break
          }
          const text = contentText(event.data.content).trim()
          /* v8 ignore next -- context events with empty content are rejected by their owning producers. */
          if (text) {
            // The tui type view lacks plugin-augmented source kinds (e.g. goal),
            // so read the display label without narrowing on `kind`. The session
            // log is a durable/replay boundary: a corrupt or foreign injected
            // source may not match the typed shape, so fall back to `context`.
            const labelled = source as { kind?: unknown; plugin?: unknown }
            const label = typeof labelled.plugin === 'string' ? labelled.plugin
              : typeof labelled.kind === 'string' ? labelled.kind
                : t('context.defaultLabel')
            const card = new ContextCardComponent(
              label, text, resolved.maxToolOutputLines, palette, renderMode, translator,
            )
            card.setExpanded(toolsVisibility === 'expanded')
            contextCards.add(card)
            chat.addChild(new Spacer(1))
            chat.addChild(card)
          }
          break
        }
        const text = displayText(contentText(event.data.content).trim())
        if (text) {
          chat.addChild(new Spacer(1))
          chat.addChild(new UserMessageComponent(text, palette, mdTheme, renderMode, t('role.you')))
          if (options.addHistory) {
            editor.addToHistory(text)
            history.add(text)
          }
        }
        break
      }
      case 'step/start':
        startAssistantStep(event.data)
        break
      // Live streamed chunks no longer travel as session events: they arrive
      // through the `agent/assistant-stream` listener below, and the settled
      // `assistant/message` embeds the exact stream for replay.
      case 'assistant/message':
        completedStreaming = undefined
        // A settled component stays attached but never absorbs a later message
        // of the same step; both the live and replay paths start a new one.
        if (streaming === undefined || streaming.isSettled() || !chat.children.includes(streaming)) startAssistantStep(event.data)
        if (streaming !== undefined) {
          streaming.settle(event.data.message.content)
          applyTurnFolding(streaming.position.turn)
        }
        break
      case 'llm/retry': {
        retractFailedStreaming()
        const retryLimit = event.data.mode === 'always' ? '∞' : String(event.data.maxRetries)
        appendNotice(t('notice.retrying', {
          retry: event.data.retry,
          limit: retryLimit,
          delayMs: event.data.delayMs,
          failure: event.data.failure.message,
        }), 'warning')
        break
      }
      // No external Spacer for tool cards: the card renders its own leading
      // gap, so the hidden state removes the row and the gap together.
      case 'tool/call':
        chat.addChild(parsedTool(event))
        trailStreamingTiming()
        break
      case 'tool/result': {
        const callId = event.data.message.toolCallId
        let card = toolCards.get(callId)
        if (card === undefined) {
          card = new ToolCardComponent(
            'tool',
            { value: {}, valid: true },
            undefined,
            resolved.maxToolOutputLines,
            resolved.maxDiffEditLength,
            palette,
            mdTheme,
            renderMode,
            translator,
          )
          card.setVisibility(toolsVisibility)
          chat.addChild(card)
          allToolCards.add(card)
        }
        card.updateResult(event.data)
        toolCards.delete(callId)
        trailStreamingTiming()
        break
      }
      case 'todo/write':
        todo.update(event.data.todos)
        break
      case 'turn/start':
        // Plan strip is turn-scoped: keep it after turn/end for reading, clear on the next turn.
        todo.update([])
        break
      case 'session/title':
        sessionTitle = event.data.title
        header.invalidate()
        updateTerminalTitle()
        break
      case 'step/end':
        if (streaming === undefined) startAssistantStep(event.data)
        streaming?.complete(event.time)
        completedStreaming = streaming
        streaming = undefined
        break
      // Every turn/end kind presents why the agent stopped: `completed` is
      // presented by the settled assistant message and its Completed timing
      // header; every other kind appends an explicit notice.
      case 'turn/end': {
        clearStreaming()
        // A replayed log can leave seed steps attached with no body (a
        // step/start whose turn never produced a message, later replaced by a
        // live attempt at other coordinates). A closing turn retires every
        // unsettled, bodyless step it owns — settled content stays rendered.
        for (const step of assistantSteps.get(event.data.turn) ?? []) {
          if (!step.isSettled() && !step.hasVisibleBody()) removeStreaming(step)
        }
        const reason = event.data.reason
        switch (reason.kind) {
          case 'completed':
            break
          case 'error':
            if (!liveErrorTurns.delete(event.data.turn)) appendNotice(reason.error.message, 'error')
            break
          case 'aborted':
            appendNotice(t(reason.reason.kind === 'disposed'
              ? 'notice.turnStoppedDisposed'
              : 'notice.turnCancelled'), 'warning')
            break
          case 'blocked':
            appendNotice(t('notice.turnBlocked'), 'warning')
            break
          case 'max-tokens':
            appendNotice(t('notice.turnMaxTokens'), 'warning')
            break
          case 'interrupted':
            appendNotice(t('notice.turnInterrupted'), 'warning')
            break
          default:
            // TurnEndReasonMap is merge-extensible: a plugin-added outcome
            // still names why the agent stopped rather than ending silently.
            appendNotice(t('notice.turnEnded', { kind: (reason as { kind: string }).kind }), 'warning')
            break
        }
        break
      }
      default:
        break
    }
  }

  const renderCompactionMarker = (): void => {
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(palette.dim(t('transcript.compactionMarker')), 0, 0))
  }

  /**
   * Replay the human transcript from the append-only log. The model-visible
   * surface shadows compacted ranges, so it is not the source here: every
   * append-origin message stays rendered, and a replacement contributes at most
   * the compaction marker at its own log position.
   *
   * The `tool/call` pairing check has no live counterpart, because only replay
   * can meet an orphan: `tool/call` carries no `surfaceOp` of its own, so it
   * inherits transcript membership from the `assistant/message` that advertised
   * it, which the live listener has necessarily just rendered. A loaded log is a
   * replay boundary, so the pairing is re-derived here instead of assumed.
   */
  const rebuildTranscript = (populateHistory: boolean): void => {
    chat.clear()
    toolCards.clear()
    allToolCards.clear()
    contextCards.clear()
    assistantSteps.clear()
    streaming = undefined
    todo.update([])
    const transcriptCalls = transcriptToolCallIds(agent.session)
    for (const event of agent.session.snapshotEvents()) {
      if (isReplacementSurfaceEvent(event)) {
        if (isCompactCheckpoint(event)) renderCompactionMarker()
        continue
      }
      if (event.type === 'tool/call' && !transcriptCalls.has(event.data.callId)) continue
      renderEvent(event, { addHistory: populateHistory })
    }
    // Side-question answers have no log to replay from, so they are re-attached
    // from live state; dropping them would erase a card the user is reading.
    for (const card of asideCards) {
      chat.addChild(new Spacer(1))
      chat.addChild(card)
    }
    requestRender()
  }

  /**
   * Rebuild the transcript and re-attach the step that is still streaming.
   *
   * Replay reconstructs only what the durable log holds, so an in-flight step's
   * un-settled blocks would be lost; every presentation change therefore carries
   * the live component across the rebuild and reapplies its own setting to it.
   * Its timing footer travels with it, because replay cannot re-create a footer
   * for a step that has no `step/end` yet. Registration re-applies turn folding,
   * so the rebuilt step keeps its header/continuation role.
   *
   * @param reapply - Applies the caller's own presentation setting to the component.
   */
  const rebuildTranscriptKeepingStream = (reapply: (step: StreamingAssistantComponent) => void): void => {
    const active = streaming
    rebuildTranscript(false)
    /* v8 ignore next -- the non-streaming command path is covered; this branch preserves an active stream across rebuild. */
    if (active === undefined) return
    streaming = active
    reapply(active)
    registerAssistantStep(active)
    chat.addChild(active)
    chat.addChild(active.timing)
  }

  const questions = createQuestionQueue({
    ctx,
    agent,
    resolved,
    palette,
    mdTheme,
    overlayManager,
    translator,
    requestRender,
    isDisposed,
    questionMaxHeight: () => {
      const width = runtime.terminal.columns
      const editorRows = editor.render(width).length
      return Math.max(1, Math.min(
        resolved.questionDialogMaxHeight,
        runtime.terminal.rows - editorRows,
      ))
    },
  })

  const approvals = createApprovalQueue({
    ctx,
    agent,
    resolved,
    palette,
    overlayManager,
    translator,
    requestRender,
    isDisposed,
    approvalMaxHeight: () => {
      const width = runtime.terminal.columns
      const editorRows = editor.render(width).length
      return Math.max(1, Math.min(
        resolved.questionDialogMaxHeight,
        runtime.terminal.rows - editorRows,
      ))
    },
  })

  const resume = createResumeController({
    ctx,
    agent,
    runtime,
    resolved,
    palette,
    overlayManager,
    translator,
    // Optional and independently mounted. Cordis transiently leaves this sibling
    // non-ACTIVE during command callbacks, so the non-strict read is intentional;
    // terminal fiber states still exclude failed, closing, and closed providers.
    sessionQuery: () => {
      const implementation = ctx.reflect._getImpl('sessionQuery', false)
      if (implementation === undefined || implementation.fiber.state >= FIBER_FAILED) return undefined
      return ctx.get('sessionQuery', false)
    },
    // The archive set lives in the workspace registry, mounted only where a
    // grouping surface exists; without it the picker hides the archived scope.
    workspaceRegistry: () => {
      const implementation = ctx.reflect._getImpl('workspaceRegistry', false)
      if (implementation === undefined || implementation.fiber.state >= FIBER_FAILED) return undefined
      return ctx.get('workspaceRegistry', false)
    },
    ui,
    editor,
    appendNotice,
    requestRender,
    isDisposed,
    agentStatus,
  })

  const rewind = createRewindController({
    ctx,
    agent,
    runtime,
    ui,
    editor,
    resolved,
    palette,
    overlayManager,
    translator,
    appendNotice,
    requestRender,
    isDisposed,
  })

  // `/render` and the transcript components share this one mode value: the
  // command mutates it, then rebuilds the transcript so every retained
  // component and every replay path render the same way.
  let renderMode: RenderMode = resolved.renderMode
  const applyRenderMode = (mode: RenderMode): void => {
    if (mode === renderMode) return
    renderMode = mode
    for (const card of allToolCards) card.setRenderMode(renderMode)
    for (const card of contextCards) card.setRenderMode(renderMode)
    for (const card of asideCards) card.setRenderMode(renderMode)
    rebuildTranscriptKeepingStream(step => { step.setRenderMode(renderMode) })
  }
  // The configured preference stays separate from the locale it resolves to:
  // `auto` re-reads the environment on every switch, and `/locale` reports which
  // of the two it acted on.
  let localeSetting: LocaleSetting = config.locale ?? 'auto'

  /** Apply one locale to every live surface: prompt, transcript, and commands. */
  const applyLocale = (locale: LocaleId): void => {
    if (locale === translator.locale) return
    retargetTranslator(translator, locale)
    void commandFiber.dispose().then(() => {
      /* v8 ignore next -- teardown disposes the channel before a queued re-registration lands. */
      if (disposed) return
      commandFiber = registerCommands()
      refreshCommandAutocomplete()
      refreshVisibleSlashAutocomplete()
    })
    // Every rendered string is derived at render time, so a rebuild is the
    // whole repaint; the streaming step carries across it like any other
    // presentation change.
    rebuildTranscriptKeepingStream(() => {})
    setStatus(agent.status)
    updateTerminalTitle()
    requestRender()
  }

  const runLocale = (rawInput: string): CommandResult => {
    const argument = rawInput.trim().toLowerCase()
    const available = LOCALE_IDS.map(id => `${id} (${LOCALE_LABELS[id]})`).join(', ')
    if (argument === '') {
      appendNotice(t('locale.current', {
        label: LOCALE_LABELS[translator.locale],
        id: translator.locale,
        available,
      }))
      return { kind: 'success' }
    }
    if (!isLocaleSetting(argument)) {
      return { kind: 'error', text: t('locale.unknownArgument', { argument }) }
    }
    const next = resolveLocale(argument)
    const fromAuto = argument === 'auto'
    if (next === translator.locale && localeSetting === argument) {
      appendNotice(t(fromAuto ? 'locale.autoUnchanged' : 'locale.already', {
        label: LOCALE_LABELS[next],
        id: next,
      }))
      return { kind: 'success' }
    }
    localeSetting = argument
    applyLocale(next)
    appendNotice(t(fromAuto ? 'locale.autoSwitched' : 'locale.switched', {
      label: LOCALE_LABELS[next],
      id: next,
    }))
    return { kind: 'success' }
  }

  const runRender = (rawInput: string): CommandResult => {
    const argument = rawInput.trim().toLowerCase()
    if (argument === '') {
      appendNotice(t('render.currentUsage', { mode: renderModeLabel(renderMode, t) }))
      return { kind: 'success' }
    }
    if (!isRenderMode(argument)) {
      return { kind: 'error', text: t('render.unknownArgument', { argument }) }
    }
    if (argument === renderMode) {
      appendNotice(t('render.already', { mode: renderModeLabel(renderMode, t) }))
      return { kind: 'success' }
    }
    applyRenderMode(argument)
    appendNotice(t('render.switched', { mode: renderModeLabel(renderMode, t) }))
    return { kind: 'success' }
  }

  // Ctrl+R opens a searchable view of the prompts submitted in this process.
  // pi-tui's own arrow-key history stays authoritative for the editor; this is
  // the searchable mirror, fed from the same submission points.
  let historyOverlay: TuiOverlaySession | undefined
  const showHistorySearch = (): void => {
    if (history.size === 0) {
      appendNotice(t('history.empty'), 'warning')
      return
    }
    void historyOverlay?.close()
    const session = overlayManager.open({
      create: () => new HistorySearchDialog(
        (query, limit) => history.search(query, limit),
        resolved.maxResumeOptions,
        palette,
        (text) => {
          void session.close()
          editor.setText(text)
          requestRender()
        },
        () => { void session.close() },
        translator,
      ),
      options: {
        width: resolved.modelDialogWidth,
        maxHeight: resolved.modelDialogMaxHeight,
        anchor: 'center',
        margin: 1,
      },
    })
    historyOverlay = session
    void session.closed.then(() => {
      if (historyOverlay === session) historyOverlay = undefined
    })
    requestRender()
  }

  const diagnostics = createDiagnosticsController({
    ctx,
    agent,
    palette,
    translator,
    appendSection: (title, rows, lines) => {
      chat.addChild(new Spacer(1))
      chat.addChild(new StatusCardComponent([[...rows]], palette, title))
      if (lines !== undefined && lines.length > 0) {
        chat.addChild(new Text(lines.map(line => palette.dim(displayText(line))).join('\n'), 0, 0))
      }
      requestRender()
    },
    notice: appendNotice,
    prices: () => resolved.prices,
    currency: () => resolved.currency,
    throughput: () => throughput,
    toolsVisibility: () => toolsVisibility,
    showReasoning: () => showReasoning,
    renderMode: () => renderModeLabel(renderMode, t),
    now,
    isDisposed,
  })

  const runExport = async (rawInput: string, signal: AbortSignal): Promise<CommandResult> => {
    const tokens = rawInput.trim().split(/\s+/u).filter(token => token !== '')
    let format: ExportFormat = 'md'
    const paths: string[] = []
    for (const token of tokens) {
      if (token === '--md' || token === '--markdown') format = 'md'
      else if (token === '--jsonl' || token === '--json') format = 'jsonl'
      else if (token.startsWith('--')) {
        return { kind: 'error', text: t('export.unknownFlag', { flag: displayInlineText(token) }) }
      } else paths.push(token)
    }
    if (paths.length > 1) {
      return { kind: 'error', text: t('export.usage') }
    }
    const cwd = agent.session.header.cwd ?? process.cwd()
    const destination = resolveExportPath(paths[0], cwd, defaultExportName(agent.session, format))
    try {
      signal.throwIfAborted()
      const result = await exportSession(agent.session, format, destination, undefined, translator)
      if (disposed) return { kind: 'success' }
      appendNotice(t('export.done', {
        events: result.events,
        bytes: result.bytes,
        path: displayText(result.path),
      }))
      return { kind: 'success' }
    } catch (error: unknown) {
      if (signal.aborted) return { kind: 'success' }
      return { kind: 'error', text: t('export.failed', { error: errorChain(error) }) }
    }
  }

  // `/btw` runs a one-shot model call outside the session log, so it can run
  // while a turn is in flight: the question and answer are process-local
  // presentation and never become model history. Each side question gets its own
  // transcript card, so a second one never overwrites the first one's answer.
  let btwController: AbortController | undefined
  const runBtw = (rawInput: string): CommandResult => {
    const question = rawInput.trim()
    if (question === '') return { kind: 'error', text: t('btw.usage') }
    const controller = new AbortController()
    btwController?.abort(new Error('superseded by a newer side question'))
    btwController = controller
    // The card goes up before the request so the transcript shows the question
    // immediately and the answer streams into it.
    const card = new AsideAnswerComponent(question, showReasoning, renderMode, palette, mdTheme, translator)
    asideCards.add(card)
    chat.addChild(new Spacer(1))
    chat.addChild(card)
    requestRender()
    void askSideQuestion(ctx, agent, question, controller.signal, {
      onChunk: (chunk) => {
        if (disposed) return
        card.update(chunk)
        requestRender()
      },
      onDone: (answer) => {
        if (btwController === controller) btwController = undefined
        if (disposed) return
        if (answer.kind === 'error') {
          card.settle(undefined, answer.message)
          requestRender()
          return
        }
        card.settle({ text: answer.text, reasoning: answer.reasoning }, undefined)
        requestRender()
      },
    }, t).catch(
      /* v8 ignore next 2 -- askSideQuestion reports every failure through onDone */
      (error: unknown) => {
        if (disposed) return
        card.settle(undefined, errorChain(error))
        requestRender()
      },
    )
    return { kind: 'success' }
  }

  const shutdown = (exitProcess: boolean): Promise<void> => {
    shuttingDown ??= (async () => {
      disposed = true
      overlayManager.beginShutdown()
      modelController.resetContextResolution()
      clearStatus()
      for (const controller of commandControllers) controller.abort(new Error('TUI disposed'))
      commandControllers.clear()
      for (const controller of referenceControllers) controller.abort(new Error('TUI disposed'))
      referenceControllers.clear()
      // A side question is a detached one-shot request, so nothing else retires
      // it: without this abort an embedder's process would keep the stream (and
      // the model call behind it) alive after the terminal is gone.
      btwController?.abort(new Error('TUI disposed'))
      btwController = undefined
      asideCards.clear()
      await tuiServiceFiber?.dispose()
      tuiServiceFiber = undefined
      questions.rejectAll()
      approvals.rejectAll()
      await overlayManager.dispose()
      modelController.clearOverlay()
      questions.unregister()
      approvals.unregister()
      await runtime.terminal.drainInput(100, 20)
      ui.stop()
      if (exitProcess) {
        if (runtime.goodbyeMessage !== undefined) {
          runtime.terminal.write(`${palette.dim(displayText(runtime.goodbyeMessage))}\n`)
        }
        runtime.exit(0)
      }
    })()
    return shuttingDown
  }

  const requestExit = (): void => {
    if (agent.status === 'running') {
      agent.cancel({ kind: 'user' })
      appendNotice(t('notice.cancellingBeforeExit'), 'warning')
      void agent.whenIdle().then(() => shutdown(true))
      return
    }
    void shutdown(true)
  }

  /** Swap the palette and all derived themes for the given terminal color scheme. */
  const applyColorScheme = (scheme: TerminalColorScheme): void => {
    if (scheme === currentScheme) return
    currentScheme = scheme
    Object.assign(palette, createPalette(resolved.theme.color, scheme))
    Object.assign(mdTheme, markdownTheme(palette))
    // The streaming step holds the same mutable palette, so it needs no
    // re-application — it only needs to survive the rebuild, unlike a step whose
    // content replay has not seen yet.
    rebuildTranscriptKeepingStream(() => {})
    // `setStatus` below re-derives `editor.borderColor` from the new palette.
    setStatus(agent.status)
    requestRender()
  }
  let currentScheme: TerminalColorScheme = 'dark'

  // Apply any color scheme the terminal reports. Registering before the query
  // below means even a synchronous reply reaches `applyColorScheme`; in practice
  // the startup query's reply is the only report, since dsh-tui leaves
  // unsolicited color-scheme notifications disabled.
  const disposeSchemeListener = ui.onTerminalColorSchemeChange(applyColorScheme)

  // Ask the terminal for its color scheme via device-status report; the reply,
  // if any, arrives through the listener above. Most terminals do not respond,
  // so we keep the dark-optimised palette. Swallow a query-write failure for the
  // same reason.
  ui.queryTerminalColorScheme({ timeoutMs: 2000 }).catch(() => {})

  const setToolsVisibility = (next: ToolCardVisibility): void => {
    toolsVisibility = next
    for (const card of allToolCards) card.setVisibility(toolsVisibility)
    // Context cards carry injected instructions rather than tool traffic, so
    // they never hide: the hidden phase reads as their collapsed preview.
    for (const card of contextCards) card.setExpanded(toolsVisibility === 'expanded')
    // Hidden mode folds each turn's steps into one assistant message; other
    // modes restore the per-step Assistant headers.
    for (const turn of assistantSteps.keys()) applyTurnFolding(turn)
    appendNotice(toolsVisibility === 'hidden'
      ? t('details.toolsHidden')
      : t('details.toolsState', { state: t(`details.phase.${toolsVisibility}`) }))
  }

  const toggleTools = (): void => {
    // The cycle order puts the two common reading modes adjacent: preview ->
    // full detail -> conversation-only, then back to the preview default.
    setToolsVisibility(toolsVisibility === 'collapsed' ? 'expanded'
      : toolsVisibility === 'expanded' ? 'hidden' : 'collapsed')
  }

  const setReasoning = (show: boolean): void => {
    showReasoning = show
    for (const card of asideCards) card.setShowReasoning(showReasoning)
    rebuildTranscriptKeepingStream(step => { step.setShowReasoning(showReasoning) })
    appendNotice(t('details.reasoningState', {
      state: t(showReasoning ? 'common.shown' : 'common.hidden'),
    }))
  }

  const toggleReasoning = (): void => { setReasoning(!showReasoning) }

  // The selector and the argument grammar mutate the same closure state the
  // Ctrl+O cycle and Ctrl+T toggle drive, so every entry converges.
  let detailsOverlay: TuiOverlaySession | undefined
  const showDetailsSelector = (): void => {
    void detailsOverlay?.close()
    const session = overlayManager.open({
      create: () => new DetailsDialog(
        toolsVisibility,
        showReasoning,
        palette,
        // Each Tab applies immediately; one dimension changes per call.
        (selection: DetailsSelection) => {
          if (selection.showReasoning !== showReasoning) setReasoning(selection.showReasoning)
          if (selection.visibility !== toolsVisibility) setToolsVisibility(selection.visibility)
        },
        () => { void session.close() },
        translator,
      ),
      options: { width: resolved.detailsDialogWidth, anchor: 'center', margin: 1 },
    })
    detailsOverlay = session
    void session.closed.then(() => {
      if (detailsOverlay === session) detailsOverlay = undefined
    })
    requestRender()
  }

  // `/theme` names the same palette the terminal's color-scheme report drives,
  // so a user can pin dark or light when their terminal does not report (or
  // reports a scheme they disagree with).
  const runTheme = (rawInput: string): CommandResult => {
    const argument = rawInput.trim()
    if (argument === '') {
      appendNotice(t('theme.current', { scheme: currentScheme }))
      return { kind: 'success' }
    }
    if (argument !== 'dark' && argument !== 'light') {
      return { kind: 'error', text: t('theme.unknownArgument') }
    }
    if (argument === currentScheme) {
      appendNotice(t('theme.already', { scheme: currentScheme }))
      return { kind: 'success' }
    }
    applyColorScheme(argument)
    appendNotice(t('theme.switched', { argument }))
    return { kind: 'success' }
  }

  // `/details` names the same transcript-detail state the Ctrl+O cycle and
  // Ctrl+T toggle mutate, so a user can jump to a mode without cycling.
  const runDetails = (rawInput: string): CommandResult => {
    const tokens = rawInput.split(/\s+/u).filter(token => token !== '')
    if (tokens.length === 0) {
      showDetailsSelector()
      return { kind: 'success' }
    }
    let visibility: ToolCardVisibility | undefined
    let reasoning: boolean | undefined
    for (let token = tokens.shift(); token !== undefined; token = tokens.shift()) {
      if (token === 'collapsed' || token === 'expanded' || token === 'hidden') {
        visibility = token
      } else if (token === 'reasoning') {
        const value = tokens[0]
        if (value === 'on' || value === 'off') {
          tokens.shift()
          reasoning = value === 'on'
        } else {
          reasoning = !showReasoning
        }
      } else {
        return { kind: 'error', text: t('details.unknownArgument', { argument: token }) }
      }
    }
    // Reasoning first: its transcript rebuild would drop the visibility notice.
    if (reasoning !== undefined) setReasoning(reasoning)
    if (visibility !== undefined) setToolsVisibility(visibility)
    return { kind: 'success' }
  }

  const showHelp = (): void => {
    const commandLines = ctx.commands.list(agent).map((command) => {
      const input = command.input === undefined ? '' : ` ${command.input.hint}`
      return `/${command.name}${input} — ${command.description}`
    })
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(palette.bold(palette.accent(t('help.shortcutsTitle'))), 0, 0))
    chat.addChild(new Text([
      t('help.line1'),
      t('help.line2'),
      t('help.line3'),
      '',
      ...commandLines,
      t('help.skillLine'),
    ].map(line => palette.dim(line)).join('\n'), 0, 0))
    requestRender()
  }

  const showPalette = (): void => {
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(
      renderPalette(palette, currentScheme, resolved.theme.color).join('\n'), 0, 0,
    ))
    requestRender()
  }

  const showStatus = async (signal: AbortSignal): Promise<void> => {
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
    /* v8 ignore next -- disposal during the awaited assembly is covered by command-owner teardown tests. */
    if (disposed) return
    /* v8 ignore next -- SystemPrompt always emits at least its required base section. */
    const systemPrompt = displayText(renderPrompt(assembly)) || t('status.emptyValue')
    const registeredTools = assembly.tools.map(tool => displayText(tool.name)).join(', ') || t('status.noTools')
    const events = agent.session.snapshotEvents()
    const latestActivity = events.findLast(event => event.type !== 'session/end-seed')?.time
      ?? agent.session.header.createdAt
    const usedContext = Math.max(0, Math.round(ctx.tokenMeter.measure(agent.session).totalTokens))
    let context = t('status.contextUnknown', { used: formatDiagnosticNumber(usedContext) })
    const contextWindow = modelController.contextWindow()
    if (contextWindow !== undefined) {
      const contextPercent = Math.round(usedContext / contextWindow * 100)
      context = `${diagnosticMeter(contextPercent, palette)} ${t('status.contextUsed', {
        percent: contextPercent,
        used: formatDiagnosticNumber(usedContext),
        window: formatDiagnosticNumber(contextWindow),
      })}`
    }
    const rate = cacheHitRate(tokens)
    const turns = events.filter(event => event.type === 'turn/start').length
    const steps = events.filter(event => event.type === 'step/start').length
    const toolCalls = events.filter(event => event.type === 'tool/call').length
    const model = target.current === undefined ? t('common.unset') : displayText(targetLabel(target.current))
    const effort = target.current === undefined
      ? t('common.unset')
      : target.current.reasoningEffort === undefined
        ? t('common.default')
        : displayText(target.current.reasoningEffort)
    const groups: readonly (readonly StatusCardRow[])[] = [
      [
        [t('status.label.session'), displayText(agent.session.id)],
        [t('status.label.title'), displayText(sessionTitle ?? t('common.untitled'))],
        [t('status.label.directory'), displayText(cwd)],
        [t('status.label.model'), `${model} ${palette.dim(t('status.effortAndReasoning', {
          effort,
          state: t(showReasoning ? 'common.shown' : 'common.hidden'),
        }))}`],
      ],
      [
        [t('status.label.agent'), [
          agent.status,
          t('count.event', { count: events.length }),
          t('count.turn', { count: turns }),
          t('count.step', { count: steps }),
          t('count.toolCall', { count: toolCalls }),
        ].join(' · ')],
      ],
      [
        [t('status.label.tokens'), t('status.tokensLine', {
          input: formatDiagnosticNumber(tokens.input),
          output: formatDiagnosticNumber(tokens.output),
        })],
        [t('status.label.kvCache'), rate === undefined
          ? t('status.kvCacheNone', {
            read: formatDiagnosticNumber(tokens.cacheRead),
            write: formatDiagnosticNumber(tokens.cacheWrite),
          })
          : `${diagnosticMeter(rate, palette)} ${t('status.kvCacheHit', {
            rate,
            read: formatDiagnosticNumber(tokens.cacheRead),
            write: formatDiagnosticNumber(tokens.cacheWrite),
          })}`],
        [t('status.label.context'), context],
      ],
      [
        [t('status.label.created'), formatDiagnosticTime(agent.session.header.createdAt)],
        [t('status.label.active'), formatDiagnosticTime(latestActivity)],
      ],
    ]
    const card = new StatusCardComponent(groups, palette, t('status.cardTitle'))
    chat.addChild(new Spacer(1))
    chat.addChild(card)
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(palette.bold(palette.accent(t('status.systemPrompt'))), 0, 0))
    chat.addChild(new Text(systemPrompt, 0, 0))
    chat.addChild(new Spacer(1))
    chat.addChild(new Text(palette.bold(palette.accent(t('status.registeredTools'))), 0, 0))
    chat.addChild(new Text(registeredTools, 0, 0))
    requestRender()
  }

  // Skill listing is async while `createTuiChat` is synchronous, so the TUI
  // retains the last complete invocation-neutral catalog for synchronous
  // editor completion, filters it for user invocation, and refreshes it after
  // registry invalidation.
  let skillCommands: SlashCommand[] = []
  let skillCommandScan = 0
  const refreshCommandAutocomplete = (): void => {
    const base = new CombinedAutocompleteProvider(
      [
        ...ctx.commands.list(agent).map(command => ({
          name: command.name,
          description: command.description,
          ...(command.input === undefined ? {} : { argumentHint: command.input.hint }),
        })),
        ...skillCommands,
      ],
      agent.session.header.cwd ?? process.cwd(),
    )
    const sessionReferenceResolver = ctx.get('sessionReferenceResolver')
    editor.setAutocompleteProvider(new ReferenceAutocompleteProvider(
      base,
      fileSearch,
      sessionReferenceResolver,
      agent,
    ))
  }
  const refreshVisibleSlashAutocomplete = (): void => {
    const cursor = editor.getCursor()
    const textBeforeCursor = editor.getLines().slice(cursor.line, cursor.line + 1).join('').slice(0, cursor.col)
    if (cursor.line === 0 && textBeforeCursor.startsWith('/') && !textBeforeCursor.includes(' ')) {
      // pi-tui's provider setter closes an existing menu but does not query
      // the replacement for the current draft. Tab in a slash-name context
      // only requests suggestions, so it refreshes without editing the text.
      editor.handleInput('\t')
    }
  }
  const disposeCommandChanges = ctx.on('commands/change', refreshCommandAutocomplete)
  refreshCommandAutocomplete()

  const refreshSkillCommands = (service: SkillRegistry): void => {
    const scan = ++skillCommandScan
    service.snapshot({ cwd, signal: skillAbort.signal }).then(
      (snapshot) => {
        if (disposed || scan !== skillCommandScan || !snapshot.complete) return
        const invocable = snapshot.skills.filter(skill => skill.invocation.userInvocable)
        // The argument-hint slot shows in the menu but is never inserted on
        // selection, so it carries the skill's scope instead of an
        // instructions placeholder. `SkillSource` is open-ended; every
        // non-project source (user, custom, bundled, runtime, …) collapses
        // to `(user)`.
        skillCommands = invocable.map(skill => ({
          name: `skill:${skill.name}`,
          description: skill.description,
          argumentHint: skill.source.startsWith('project-') ? '(project)' : '(user)',
        }))
        refreshCommandAutocomplete()
        refreshVisibleSlashAutocomplete()
        requestRender()
      },
      () => {
        // Discovery failed or was aborted on dispose; keep the base slash
        // commands so autocomplete still works without skill entries.
      },
    )
  }
  const disposeSkillChanges = skills === undefined
    ? () => {}
    : ctx.on('skills/change', () => { refreshSkillCommands(skills) })
  if (skills !== undefined) refreshSkillCommands(skills)

  // The agent scope is minted by agent-loop and intentionally inherits only
  // that core plugin's dependencies. A child command producer declares its own
  // UI-service dependency while retaining the parent agent scope and lifetime.
  //
  // Registration is re-runnable because a command descriptor's description is a
  // plain string captured at registration: `/locale` disposes this fiber and
  // calls it again so the help listing and slash autocomplete switch language
  // with everything else.
  const registerCommands = (): Fiber => agent.ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'help',
      description: t('cmd.help.description'),
      handler: () => { showHelp(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'model',
      description: t('cmd.model.description'),
      input: { hint: '[[provider/]model]' },
      handler: ({ rawInput }) => {
        modelController.queueModelCommand(rawInput)
        return { kind: 'success' }
      },
    })
    commandCtx.commands.register({
      name: 'clear',
      description: t('cmd.clear.description'),
      handler: () => { chat.clear(); requestRender(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'details',
      description: t('cmd.details.description'),
      input: { hint: '[collapsed|expanded|hidden] [reasoning [on|off]]' },
      handler: ({ rawInput }) => runDetails(rawInput),
    })
    commandCtx.commands.register({
      name: 'palette',
      description: t('cmd.palette.description'),
      handler: () => { showPalette(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'theme',
      description: t('cmd.theme.description'),
      input: { hint: '[dark|light]' },
      handler: ({ rawInput }) => runTheme(rawInput),
    })
    commandCtx.commands.register({
      name: 'render',
      description: t('cmd.render.description'),
      input: { hint: '[rich|plain]' },
      handler: ({ rawInput }) => runRender(rawInput),
    })
    commandCtx.commands.register({
      name: 'doctor',
      description: t('cmd.doctor.description'),
      handler: () => { diagnostics.runDoctor(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'cost',
      description: t('cmd.cost.description'),
      input: { hint: '[--json]' },
      handler: ({ rawInput }) => { diagnostics.runCost(rawInput); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'mcp',
      description: t('cmd.mcp.description'),
      handler: () => { diagnostics.runMcp(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'export',
      description: t('cmd.export.description'),
      input: { hint: '[--md|--jsonl] [path]' },
      handler: async ({ rawInput, signal }) => await runExport(rawInput, signal),
    })
    commandCtx.commands.register({
      name: 'btw',
      description: t('cmd.btw.description'),
      input: { hint: '<question>' },
      // The question is deliberately kept out of the durable log, so the
      // lifecycle event must not carry it either — that is the whole point of a
      // side question.
      recordInput: false,
      handler: ({ rawInput }) => runBtw(rawInput),
    })
    commandCtx.commands.register({
      name: 'rewind',
      description: t('cmd.rewind.description'),
      handler: () => { rewind.showRewind(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'fork',
      description: t('cmd.fork.description'),
      handler: () => { rewind.showRewind(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'history',
      description: t('cmd.history.description'),
      handler: () => { showHistorySearch(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'reload',
      description: t('cmd.reload.description'),
      handler: () => { runReload(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'resume',
      description: t('cmd.resume.description'),
      input: { hint: '[--archived]' },
      handler: ({ rawInput }) => {
        const argument = rawInput.trim()
        if (argument !== '' && argument !== '--archived') {
          return { kind: 'error', text: t('resume.unknownArgument', { argument }) }
        }
        resume.showResume(argument === '--archived' ? 'archived' : 'workspace')
        return { kind: 'success' }
      },
    })
    commandCtx.commands.register({
      name: 'new',
      description: t('cmd.new.description'),
      handler: () => { resume.startNew(); return { kind: 'success' } },
    })
    commandCtx.commands.register({
      name: 'status',
      description: t('cmd.status.description'),
      handler: async ({ signal }) => { await showStatus(signal); return { kind: 'success' } },
    })
    const exitHandler = (): CommandResult => {
      requestExit()
      return { kind: 'success' }
    }
    commandCtx.commands.register({
      name: 'exit',
      description: t('cmd.exit.description'),
      handler: exitHandler,
    })
    commandCtx.commands.register({
      name: 'quit',
      description: t('cmd.quit.description'),
      handler: exitHandler,
    })
    commandCtx.commands.register({
      name: 'locale',
      description: t('cmd.locale.description'),
      input: { hint: '[en|zh|auto]' },
      handler: ({ rawInput }) => runLocale(rawInput),
    })
  })
  let commandFiber = registerCommands()
  const fileReferencePromptFiber = agent.ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({
      name: 'ui:tui-file-reference',
      order: 99,
      // Tool visibility can change dynamically or by agent scope. Empty
      // sections are omitted by renderPrompt, so guidance never names a tool
      // that this agent cannot call.
      text: () => agent.ctx.tools.get('read', agent) === undefined ? '' : FILE_REFERENCE_PROMPT,
    })
  })

  const runCommand = (text: string): void => {
    const controller = new AbortController()
    commandControllers.add(controller)
    void ctx.commands.execute(agent, text, [], controller.signal).then(
      (execution) => {
        if (disposed) return
        if (execution === undefined) {
          appendNotice(t('notice.unknownCommand', { text }), 'warning')
        } else if (execution.result.text !== undefined && execution.result.text !== '') {
          appendNotice(execution.result.text, execution.result.kind === 'error' ? 'error' : 'info')
        }
      },
      (error: unknown) => {
        if (!disposed) {
          appendNotice(t('notice.commandFailed', { error: errorChain(error) }), 'error')
        }
      },
    ).finally(() => { commandControllers.delete(controller) })
  }

  const dispatchMessage = (content: ContentBlock[], attachedContext?: UserMessage): void => {
    if (disposed) {
      appendNotice(t('notice.agentDisposed', { id: agent.id }), 'error')
      return
    }
    if (agent.status === 'running') {
      // Both messages target next-step; append the prepared snapshot first so
      // the loop claims it before the waking steering message.
      if (attachedContext !== undefined) {
        agent.inject(attachedContext)
      }
      const message = createUserMessage({ content, source: { kind: 'user' } })
      agent.steer(message)
      pendingSteering.add(message.id)
      refreshStatus()
      return
    }
    // Idle: next-step context and the queued prompt are claimed as one
    // batch, so a rejecting pre-step listener consumes both.
    if (attachedContext !== undefined) agent.inject(attachedContext)
    agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
  }

  /** Deliver a user turn to the agent: steer while running, send while idle, or report a disposed agent. */
  const deliver = (payload: string): void => {
    dispatchMessage([{ type: 'text', text: payload }])
  }

  /** Load a manually invoked skill and deliver its rendered body as a user turn, reporting lookup outcomes as notices. */
  const invokeSkill = (name: string, instructions: string): void => {
    if (skills === undefined) {
      appendNotice(t('skill.unavailable'), 'warning')
      return
    }
    const lookup = { cwd, signal: skillAbort.signal }
    const reportFailure = (error: unknown): void => {
      if (disposed) return
      appendNotice(t('skill.loadFailed', { name, error: errorChain(error) }), 'error')
    }
    skills.list(lookup).then(
      (summaries) => {
        if (disposed) return
        const summary = summaries.find(skill => skill.name === name)
        if (summary === undefined) {
          appendNotice(t('skill.unknown', { name }), 'warning')
          return
        }
        if (!summary.invocation.userInvocable) {
          appendNotice(t('skill.notInvocable', { name }), 'warning')
          return
        }
        skills.get(name, lookup).then(
          (skill) => {
            if (disposed) return
            if (skill === undefined) {
              appendNotice(t('skill.unknown', { name }), 'warning')
              return
            }
            if (!skill.invocation.userInvocable) {
              appendNotice(t('skill.notInvocable', { name }), 'warning')
              return
            }
            deliver(renderSkillInvocation(skill, instructions))
          },
          reportFailure,
        )
      },
      reportFailure,
    )
  }

  // EXPERIMENTAL, dev-only: manually re-read every file-backed loader config
  // tree and apply the diff to the running app — the same path the HMR
  // watcher's config-change branch drives, minus the watcher. Useful when the
  // watcher misses an edit (replace-by-rename saves) or HMR is not mounted.
  // Module-source hot reload stays watcher-owned; this refreshes configs only.
  let reloadInFlight = false
  const runReload = (): void => {
    // Idle-only: a reload can dispose and re-mount entries mid-flight; doing
    // that under an active turn could tear tools or the adapter out from
    // under in-flight calls. Idleness is advisory (a send can race in after
    // the check), but it removes the common footgun.
    if (agent.status !== 'idle') {
      appendNotice(t('reload.requiresIdle', { status: agent.status }), 'warning')
      return
    }
    // Re-entrancy guard: concurrent refreshes over a genuinely changed file
    // would race unmutexed tree updates (create/remove interleaving); one
    // reload at a time keeps the update pass single-writer.
    if (reloadInFlight) {
      appendNotice(t('reload.alreadyRunning'), 'warning')
      return
    }

    // Optional-service lookup: the TUI must not depend on the Loader (tests
    // and embedders run without one), so `loader` stays out of `inject` and
    // is read through the non-throwing `ctx.get` accessor — a bare `ctx.loader`
    // proxy read would throw `cannot get property without inject` in a fiber.
    const loader = ctx.get('loader') as { entries(): Iterable<{ subtree?: { refresh?(): Promise<void> } }> } | undefined
    if (loader === undefined) {
      appendNotice(t('reload.requiresLoader'), 'warning')
      return
    }
    const refreshes: Promise<void>[] = []
    for (const entry of loader.entries()) {
      if (entry.subtree?.refresh !== undefined) refreshes.push(entry.subtree.refresh())
    }
    reloadInFlight = true
    appendNotice(t('reload.reloading', { count: refreshes.length }))
    // refresh() never rejects (it warns and keeps the running tree), so the
    // join can only fulfill; the catch arm guards a future contract change.
    void Promise.all(refreshes).then(() => {
      appendNotice(t('reload.complete'))
    }).catch((error: unknown) => {
      appendNotice(t('reload.failed', { error: errorChain(error) }), 'error')
    }).finally(() => {
      reloadInFlight = false
    })
  }

  editor.onSubmit = (value: string) => {
    const text = value.trim()
    if (text === '') return
    const restoreSubmittedInput = (): void => {
      if (editor.getText() === '') editor.setText(value)
    }
    // `/skill:<name>` carries a colon, which the command registry's name
    // grammar rejects, so it is intercepted before generic command routing.
    if (text.startsWith(SKILL_COMMAND_PREFIX)) {
      editor.addToHistory(text)
      history.add(text)
      editor.setText('')
      const { name: skillName, instructions } = parseSkillCommand(text)
      if (skillName === '') appendNotice(t('skill.usage'), 'warning')
      else invokeSkill(skillName, instructions)
      return
    }
    if (value.startsWith('/')) {
      editor.addToHistory(text)
      history.add(text)
      editor.setText('')
      runCommand(value)
      return
    }
    let parsed: ReturnType<typeof parseSessionReferenceText>
    try {
      parsed = parseSessionReferenceText(text)
    } catch (error: unknown) {
      restoreSubmittedInput()
      appendNotice(t('sessionRef.invalid', { error: errorChain(error) }), 'error')
      return
    }
    if (parsed.references.length === 0) {
      editor.addToHistory(text)
      history.add(text)
      editor.setText('')
      dispatchMessage([{ type: 'text', text: parsed.text }])
      return
    }
    const sessionReferenceResolver = ctx.get('sessionReferenceResolver')
    if (sessionReferenceResolver === undefined) {
      restoreSubmittedInput()
      appendNotice(t('sessionRef.unavailable'), 'error')
      return
    }
    const controller = new AbortController()
    referenceControllers.add(controller)
    editor.disableSubmit = true
    void sessionReferenceResolver.prepare(
      agent,
      [{ type: 'text', text: parsed.text }],
      parsed.references,
      controller.signal,
    ).then((prepared) => {
      if (disposed) return
      editor.addToHistory(text)
      history.add(text)
      if (editor.getText() === value) editor.setText('')
      // The snapshot travels with the prompt so a blocking admission hook
      // discards them together — see dispatchMessage's attached-context path.
      dispatchMessage(prepared.content, prepared.additionalContext)
    }, (error: unknown) => {
      if (!disposed && !controller.signal.aborted) {
        restoreSubmittedInput()
        appendNotice(t('sessionRef.failed', { error: errorChain(error) }), 'error')
      }
    }).finally(() => {
      referenceControllers.delete(controller)
      editor.disableSubmit = false
      requestRender()
    })
  }

  const removeInputListener = ui.addInputListener((data) => {
    if (overlayManager.hasActiveOverlay()) return undefined
    if (matchesKey(data, Key.ctrl('o'))) {
      toggleTools()
      return { consume: true }
    }
    // Ctrl+R searches prompt history; reasoning display moved to Ctrl+T so the
    // search gesture matches the shell convention users already have.
    if (matchesKey(data, Key.ctrl('r'))) {
      showHistorySearch()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('t'))) {
      toggleReasoning()
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('l'))) {
      ui.invalidate()
      ui.requestRender(true)
      return { consume: true }
    }
    if (matchesKey(data, Key.escape)) {
      if (agent.status === 'running') {
        agent.cancel({ kind: 'user' })
        return { consume: true }
      }
      // Double Esc on an idle agent opens the rewind/fork picker. The window is
      // short and the first press only arms the gesture — nothing happens until
      // the second one lands, so a single Esc never surprises the user. The
      // first press is not consumed, so the editor still sees it.
      const pressedAt = now()
      const armed = lastEscapeAt !== undefined && pressedAt - lastEscapeAt <= DOUBLE_ESCAPE_WINDOW_MS
      lastEscapeAt = armed ? undefined : pressedAt
      if (armed) {
        rewind.showRewind()
        return { consume: true }
      }
      return undefined
    }
    if (matchesKey(data, Key.ctrl('c'))) {
      if (agent.status === 'running') {
        agent.cancel({ kind: 'user' })
      } else if (editor.getText() !== '') {
        editor.setText('')
      } else {
        requestExit()
      }
      return { consume: true }
    }
    if (matchesKey(data, Key.ctrl('d'))) {
      if (agent.status === 'running') appendNotice(t('notice.exitBlocked'), 'warning')
      else requestExit()
      return { consume: true }
    }
    return undefined
  })

  const disposeSessionEvents = ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'tool/result') fileSearch.invalidate()
    recordEventUsage(tokens, event)
    // Each settled step teaches the throughput estimator the characters-to-tokens
    // ratio this route actually bills, so the live rate converges on TPS proper.
    if (event.type === 'assistant/message' && event.data.usage !== undefined) {
      throughput.settleStep(event.data.usage.outputTokens, outputCharacters(event.data.message.content))
    }
    if (event.type === 'turn/start') {
      // A new turn starts with an empty window: the previous turn's rate must
      // not linger while this one waits for its first token.
      throughput.resetWindow()
      if (runningStatus !== undefined) runningStatus.turn = event.data.turn
    }
    // Track live standalone compaction state.
    if (event.type === 'compaction/start' && event.data.turn === null) {
      if (compacting === undefined) {
        const startedAt = now()
        compacting = {
          startedAt,
          timer: setInterval(renderStatus, STATUS_ANIMATION_INTERVAL_MS),
        }
        runtime.terminal.setProgress(true)
      }
      requestRender()
      return
    }
    if (event.type === 'compaction/end' && event.data.turn === null && compacting !== undefined) {
      const fadeOutGlyph = runningPhaseGlyph(undefined, false, true)
      clearInterval(compacting.timer)
      compacting = undefined
      if (event.data.error !== undefined) {
        appendNotice(t('notice.compactionFailed', { error: event.data.error }), 'warning')
      }
      // A concurrently running turn owns the indicator. Keep its timer and
      // progress bit instead of letting the compaction fade clear that state.
      if (runningStatus === undefined && fadeOutGlyph !== undefined) beginFadeOut(fadeOutGlyph)
      requestRender()
      return
    }
    // A replacement mutates only the model surface, so the rendered transcript
    // keeps what it already showed; a landed summary checkpoint adds its marker.
    if (isReplacementSurfaceEvent(event)) {
      if (isCompactCheckpoint(event)) renderCompactionMarker()
      requestRender()
      return
    }
    renderEvent(event, { addHistory: false })
    requestRender()
  })
  // Live model streams are process-local publications (`agent/assistant-stream`
  // frames), not session events. `start`/`chunk` frames drive the streaming
  // component; the settled `assistant/message` session event embeds the exact
  // stream and owns the final content, so a committed `end` renders nothing.
  // Chunk frames omit turn/step coordinates, so the position carried by each
  // attempt's `start` frame is remembered keyed by `attemptId`.
  const streamPositions = new Map<string, StepPosition>()
  const disposeStream = ctx.on('agent/assistant-stream', ({ agent: subject, frame }) => {
    if (subject !== agent || disposed) return
    if (frame.type === 'start') {
      const position = { turn: frame.turn, step: frame.step }
      streamPositions.set(frame.attemptId, position)
      if (streaming === undefined
        || streaming.position.turn !== position.turn
        || streaming.position.step !== position.step) {
        startAssistantStep(position)
      } else {
        // A retried attempt republishes the step's stream from scratch.
        streaming.restart()
      }
      if (streaming !== undefined) applyTurnFolding(streaming.position.turn)
    } else if (frame.type === 'chunk') {
      const position = streamPositions.get(frame.attemptId)
      if (position !== undefined) {
        stepTimingTracker.feedLiveChunk(position, frame.time, frame.chunk)
      }
      throughput.feed(frame.chunk, frame.time)
      if (streaming !== undefined && position !== undefined
        && streaming.position.turn === position.turn
        && streaming.position.step === position.step) {
        streaming.update(frame.chunk)
        // The first streamed text/reasoning may make this step the turn's
        // hidden-mode header owner (or a continuation with a visible body).
        applyTurnFolding(streaming.position.turn)
      }
    } else if (frame.type === 'end') {
      streamPositions.delete(frame.attemptId)
      // An abandoned attempt (retry/cancel/stream error) leaves no durable
      // event; drop its partial blocks so the card does not keep content the
      // model never committed. A committed attempt is settled below by the
      // `assistant/message` session event.
      if (frame.outcome.kind === 'abandoned' && streaming !== undefined
        && !streaming.isSettled()) {
        streaming.restart()
      }
    }
    requestRender()
  })
  const settlePendingSteering = (id: MessageId): void => {
    if (pendingSteering.delete(id)) refreshStatus()
  }
  const disposeClaimed = ctx.on('agent/inbox/claimed', ({ agent: subject, message }) => {
    if (subject === agent) settlePendingSteering(message.id)
  })
  const disposeDiscarded = ctx.on('agent/inbox/discarded', ({ agent: subject, message }) => {
    if (subject === agent) settlePendingSteering(message.id)
  })
  const disposeStatus = ctx.on('agent/status', ({ agent: subject, status }) => {
    if (subject !== agent) return
    // Leaving 'running' ends the turn's status line; clear any badge so the
    // next running turn starts from zero (and a cancellation, which discards
    // the queue without logging drains, cannot strand a stale count).
    if (status !== 'running') pendingSteering.clear()
    setStatus(status)
  })
  const disposeError = ctx.on('agent/error', ({ agent: subject, turn, error }) => {
    if (subject !== agent) return
    liveErrorTurns.add(turn)
    // Full cause chain: wrapper messages like `fetch failed` carry the
    // actionable transport detail on `cause`.
    appendNotice(errorChain(error), 'error')
  })
  const disposeAgent = ctx.on('agent/disposed', ({ agent: subject }) => {
    if (subject !== agent) return
    // The agent left the registry (e.g. an agent-loop-only reload) while the
    // TUI stays mounted. Retained agents accept deliveries after detachment, so
    // without this a later send would drive a zombie agent/session; mark
    // disposed so dispatchMessage reports it instead.
    // The hard clear also retires live compaction. A later compaction/end is
    // intentionally presentation-silent: this disposal notice owns the
    // terminal outcome, and no animation may survive agent detachment.
    clearStatus()
    appendNotice(t('notice.agentWasDisposed', { id: agent.id }), 'warning')
    disposed = true
  })

  const detachListeners = (): void => {
    skillAbort.abort()
    fileSearch.dispose()
    removeInputListener()
    disposeCommandChanges()
    disposeSkillChanges()
    disposePromptChanges()
    for (const value of promptValues) value.dispose()
    stopBannerReveal()
    disposeSessionEvents()
    disposeStream()
    disposeClaimed()
    disposeDiscarded()
    disposeStatus()
    disposeError()
    disposeAgent()
    disposeSchemeListener()
    disposeTargetListeners()
    modelController.detach()
  }

  // Sweep reveal of the whole banner: the header wipes in left-to-right over
  // ~BANNER_REVEAL_STEPS frames (started after `ui.start()` succeeds).
  // Configured subtitles skip it so deployments (and snapshot fixtures) stay
  // frame-deterministic.
  let revealTimer: ReturnType<typeof setInterval> | undefined
  const stopBannerReveal = (): void => {
    if (revealTimer === undefined) return
    clearInterval(revealTimer)
    revealTimer = undefined
    header.setRevealWidth(undefined)
  }
  const startBannerReveal = (): void => {
    if (config.welcome !== undefined) return
    const total = Math.max(1, runtime.terminal.columns)
    const step = Math.max(1, Math.ceil(total / BANNER_REVEAL_STEPS))
    let shown = 0
    header.setRevealWidth(0)
    revealTimer = setInterval(() => {
      shown += step
      if (shown >= total) {
        stopBannerReveal()
      } else {
        header.setRevealWidth(shown)
      }
      requestRender()
    }, BANNER_REVEAL_INTERVAL_MS)
  }

  rebuildTranscript(true)
  const restoredGoal = foldGoal(agent.session.snapshotEvents()).goal
  /* v8 ignore next -- goal replay coverage lives with the goal seam; the TUI only formats its startup notice. */
  if (restoredGoal !== undefined && restoredGoal.phase !== 'complete') {
    appendNotice(t('goal.restored', { phase: restoredGoal.phase }), 'warning')
  }
  setStatus(agent.status)
  try {
    ui.start()
  } catch (error: unknown) {
    disposed = true
    detachListeners()
    void Promise.all([
      commandFiber.dispose(),
      fileReferencePromptFiber.dispose(),
    ]).catch(
      /* v8 ignore next 2 -- command registration cleanup is non-throwing; this guards a future disposer regression */
      (cleanupError: unknown) => {
        ctx.logger.warn(`ui-tui: scoped cleanup after startup failure failed: ${errorChain(cleanupError)}`)
      },
    )
    clearStatus()
    questions.unregister()
    approvals.unregister()
    ui.stop()
    throw error
  }
  tuiServiceFiber = ctx.inject([], (serviceCtx) => {
    new TuiExtensionServiceImpl(serviceCtx, agent, overlayManager)
  })
  startBannerReveal()

  // A launcher-seeded first turn (`dsh migrate`/`dsh upgrade`):
  // invoke the named skill exactly as a typed `/skill:<name>` would, once the
  // chat is live and the agent is idle. The launcher sets this only for a fresh
  // session, so there is no prior turn to collide with; invokeSkill reports an
  // unknown skill as a notice. The value may arrive from config or the
  // `tuiInitialSkill` host key, both of which bypass the CLI's own trimming, so
  // normalize at this single consumption point and treat a blank name as absent
  // rather than reporting it as an unknown skill.
  const seededSkill = config.initialSkill?.trim()
  if (seededSkill !== undefined && seededSkill !== '') invokeSkill(seededSkill, '')

  return {
    async dispose(): Promise<void> {
      detachListeners()
      await shutdown(false)
      await Promise.all([
        commandFiber.dispose(),
        fileReferencePromptFiber.dispose(),
      ])
    },
  }
}

/**
 * Open the pi-tui channel once its configured agent exists.
 *
 * @param ctx - Context supplying the agent registry, tools, and event stream.
 * @param config - Target agent and presentation configuration.
 * @param runtime - Terminal and process-exit boundary.
 */
export function mountTui(ctx: Context, config: Config, runtime: TuiRuntime): void {
  const sessionId = SessionId(config.sessionId ?? 'main')
  const matchesConfiguredIdentity = (agent: Agent): boolean =>
    agent.id === sessionId && ctx.agents.roots().includes(agent)
  let settled = false

  const stopWaiting = (): void => {
    disposeCreated()
    disposeFailure()
  }
  const start = (agent: Agent): void => {
    if (settled || !matchesConfiguredIdentity(agent)) return
    settled = true
    stopWaiting()
    ctx.effect(() => {
      const controller = createTuiChat(ctx, config, runtime)
      return () => controller.dispose()
    }, 'ui-tui')
  }
  const fail = ({ sessionId: failedSessionId, error }: { sessionId: SessionId; error: unknown }): void => {
    if (settled || failedSessionId !== sessionId) return
    settled = true
    stopWaiting()
    runtime.terminal.write(displayText(`ui-tui: session "${sessionId}" failed to start: ${errorChain(error)}\n`))
    runtime.exit(1)
  }

  const disposeCreated = ctx.on('agent/created', ({ agent }) => { start(agent) })
  const disposeFailure = ctx.on('agent-loop/config-start-failed', fail)
  const existing = ctx.agents.roots().find(agent => agent.id === sessionId)
  if (existing !== undefined) start(existing)
}

const ROOT_DISPOSE_TIMEOUT_MS = 5_000

/**
 * Dispose the whole application before process exit, with a bounded fallback.
 * @param ctx - The TUI plugin context whose root owns sibling resources.
 * @param code - Process status to report.
 * @param exit - Exit boundary, replaceable by tests.
 */
export function disposeRootAndExit(
  ctx: Context,
  code: number,
  exit: (status: number) => void = (status) => { process.exit(status) },
): void {
  let exited = false
  const exitOnce = (): void => {
    if (exited) return
    exited = true
    exit(code)
  }
  const timeout = setTimeout(exitOnce, ROOT_DISPOSE_TIMEOUT_MS)
  void ctx.root.fiber.dispose().then(
    () => { clearTimeout(timeout); exitOnce() },
    () => { clearTimeout(timeout); exitOnce() },
  )
}

/** Cordis entry point using the process terminal; explicit TUI composition requires a TTY pair. */
/* v8 ignore start -- production process wiring; fake-terminal tests cover mountTui/createTuiChat,
   and apps/cli PTY smokes cover the real entry */
export function apply(ctx: Context, config: Config): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('ui-tui: both stdin and stdout must be TTYs; use the one-shot @deepseek-ai/dsh-cli-demo app for pipes')
  }
  // Truecolor is a terminal capability, so detect it here at the process
  // boundary from COLORTERM; an explicit theme value still wins.
  const truecolor = config.theme?.truecolor ?? ['truecolor', '24bit'].includes(process.env.COLORTERM ?? '')
  const resumeHost = ctx.get('tuiResumeHost')
  const hostNew = resumeHost?.handoffNew
  const goodbyeMessage = ctx.get('tuiGoodbyeMessage')
  // The launcher seeds a guided fresh session's first turn through this key; a
  // config value still wins. Consumed in createTuiChat via config.initialSkill.
  const initialSkill = config.initialSkill ?? ctx.get('tuiInitialSkill')
  mountTui(ctx, Object.assign(
    {},
    config,
    { theme: Object.assign({}, config.theme, { truecolor }) },
    initialSkill === undefined ? {} : { initialSkill },
  ), {
    terminal: new ProcessTerminal(),
    exit: (code) => { disposeRootAndExit(ctx, code) },
    ...resumeHost === undefined ? {} : {
      handoffResume: (sessionId, cwd) => resumeHost.handoff(sessionId, cwd),
      ...hostNew === undefined ? {} : { handoffNew: (cwd: string) => hostNew(cwd) },
    },
    ...goodbyeMessage === undefined ? {} : { goodbyeMessage },
  })
}
/* v8 ignore stop */
