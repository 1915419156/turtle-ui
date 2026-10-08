import {
  createUserMessage,
  LlmAttemptId,
  MessageId,
  createMessage,
} from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import type { Terminal } from '@earendil-works/pi-tui'
import AgentRegistry, {
  agentEvents,
  type Agent,
  type AgentCancelCause,
  type AgentOptions,
  type AgentStatus,
  type AssistantStreamFrame,
} from '@deepseek-ai/dsh-agent'
import type {
  ContentBlock,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import CommandService from '@deepseek-ai/dsh-commands'
import SessionStore, {
  SessionId,
  type Session,
  type SessionEvent,
  type SessionHeader,
  type UserMessage,
} from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { type ToolDefinition } from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { createTuiChat, type Config, type TuiRuntime } from '../src/index.ts'
import { TestSessionQueryEngine } from './session-query.ts'
import TuiPromptService from '../src/prompt.ts'

interface FakeAgent extends Agent {
  status: AgentStatus
  sent: readonly (readonly ContentBlock[])[]
  sentMessages: UserMessage[]
  steered: readonly (readonly ContentBlock[])[]
  steeredIds: MessageId[]
  steeredOptions: UserMessage[]
  injected: readonly (readonly ContentBlock[])[]
  injectedOptions: UserMessage[]
  cancelled: AgentCancelCause[]
}

export interface TuiHarnessOptions {
  status?: AgentStatus
  config?: Config
  /** Leave the session event log empty instead of seeding one turn and step. */
  omitInitialLifecycle?: boolean
  /** Omit the harness's default `welcome`, exercising the banner sweep-reveal path. */
  omitWelcome?: boolean
  tools?: Record<string, ToolDefinition>
  configureContext?: (ctx: Context) => Promise<void>
  beforeMount?: (session: Session) => void
  cwd?: string | null
  formatCwd?: TuiRuntime['formatCwd']
  gitBranch?: TuiRuntime['gitBranch']
  /** Fake-agent creation options (`provider`/`model` seed the model selector's initial target). */
  agentOptions?: AgentOptions
  contextWindow?: number
  contextTokens?: number
  now?: () => number
  catalog?: {
    providers: LlmProviderInfo[]
    models: LlmModelInfo[]
    listModels?: (provider: string) => Promise<LlmModelInfo[]>
    resolveModelInfo?: (
      provider: string,
      model: string,
    ) => Promise<Pick<LlmResolvedModelInfo, 'context' | 'reasoning'>>
  }
  /**
   * Provide a fake `sessionPersistence` service so resume surfaces can list
   * sessions. The simplified test-side shape (`list`/`load`) is adapted to the
   * rc.2 handle-based `SessionPersistence` contract in
   * {@link adaptSessionPersistence}.
   */
  sessionPersistence?: {
    list(): Promise<SessionHeader[]>
    load?(id: ReturnType<typeof SessionId>): Promise<{ meta: SessionHeader; events: readonly SessionEvent[] }>
  }
  handoffResume?: TuiRuntime['handoffResume']
  /** Host-supplied fresh-session handoff; absent exercises the `/new` unavailability path. */
  handoffNew?: TuiRuntime['handoffNew']
  /** Host-supplied exit line; absent exercises the no-message path. */
  goodbyeMessage?: TuiRuntime['goodbyeMessage']
  /** Set false to exercise the optional session-query degradation path. */
  mountSessionQuery?: boolean
}

export interface TuiHarness<TerminalType extends Terminal, Exit extends (code: number) => void> {
  ctx: Context
  session: Session
  agent: FakeAgent
  terminal: TerminalType
  exit: Exit
  controller: ReturnType<typeof createTuiChat>
}

/**
 * Compose the production TUI around an in-memory session and controllable agent.
 * @param terminal - Terminal boundary driven by the test.
 * @param exit - Process-exit observer.
 * @param options - Initial session, agent, tool, and TUI configuration.
 * @returns The mounted TUI and every boundary the test may drive or inspect.
 */
export async function createTuiTestHarness<TerminalType extends Terminal, Exit extends (code: number) => void>(
  terminal: TerminalType,
  exit: Exit,
  options: TuiHarnessOptions = {},
): Promise<TuiHarness<TerminalType, Exit>> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(CommandService)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(TuiPromptService)
  const catalog = options.catalog ?? {
    providers: [{ id: 'deepseek-official', name: 'DeepSeek' }],
    models: [
      { provider: 'deepseek-official', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { provider: 'deepseek-official', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
  }
  ctx.provide('tokenMeter', {
    measure() {
      return { totalTokens: options.contextTokens ?? 0 }
    },
  } as never)
  if (options.configureContext === undefined) {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    for (const tool of Object.values(options.tools ?? {})) ctx.tools.register(tool)
  } else {
    await options.configureContext(ctx)
  }
  // A configureContext may mount the real LlmService; only fill the
  // advisory-catalog stub when none was provided.
  if (ctx.get('llm') === undefined) {
    ctx.provide('llm', {
      listProviders() {
        return catalog.providers.map(provider => ({ ...provider }))
      },
      listModels(provider: string) {
        return catalog.listModels?.(provider)
          ?? Promise.resolve(catalog.models.filter(model => model.provider === provider).map(model => ({ ...model })))
      },
      async resolveModelInfo(provider: string, model: string) {
        const advertised = catalog.models.find(candidate =>
          candidate.provider === provider && candidate.id === model)
        const capabilities = await (catalog.resolveModelInfo?.(provider, model)
          ?? Promise.resolve({
            context: { contextWindow: options.contextWindow ?? 128_000 },
          }))
        return {
          provider,
          id: model,
          name: advertised?.name ?? model,
          ...advertised?.description === undefined ? {} : { description: advertised.description },
          ...capabilities,
        }
      },
    } as never)
  }
  if (ctx.get('systemPrompt') === undefined) await ctx.plugin(SystemPrompt)
  if (options.sessionPersistence !== undefined) {
    ctx.provide('sessionPersistence', adaptSessionPersistence(options.sessionPersistence) as never)
  }
  if (options.mountSessionQuery !== false && ctx.get('sessionQuery') === undefined) {
    await ctx.plugin(TestSessionQueryEngine)
  }
  const sessionId = SessionId('main-session')
  const session = ctx.sessions.create(
    sessionId,
    options.cwd === null ? undefined : { meta: { cwd: options.cwd ?? '/workspace' } },
  )
  if (options.omitInitialLifecycle !== true) {
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
  }
  options.beforeMount?.(session)
  const sent: (readonly ContentBlock[])[] = []
  const sentMessages: UserMessage[] = []
  const steered: (readonly ContentBlock[])[] = []
  const steeredIds: MessageId[] = []
  const steeredOptions: UserMessage[] = []
  const injected: (readonly ContentBlock[])[] = []
  const injectedOptions: UserMessage[] = []
  const cancelled: AgentCancelCause[] = []
  const agent: FakeAgent = {
    id: sessionId,
    options: options.agentOptions ?? { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    session,
    inbox: {} as Agent['inbox'],
    status: options.status ?? 'idle',
    ctx,
    sent,
    sentMessages,
    steered,
    steeredIds,
    steeredOptions,
    injected,
    injectedOptions,
    cancelled,
    send(input) {
      sent.push(input.content)
      sentMessages.push(input)
    },
    followup(input) {
      sent.push(input.content)
      sentMessages.push(input)
    },
    steer(input) {
      steered.push(input.content)
      steeredOptions.push(input)
      steeredIds.push(input.id)
    },
    inject(input) {
      injected.push(input.content)
      injectedOptions.push(input)
    },
    cancel(cause) {
      cancelled.push(cause)
    },
    whenIdle() {
      return Promise.resolve()
    },
    runMaintenance(task) {
      return task(new AbortController().signal)
    },
  }
  await ctx.agents.register(agent)
  const controller = createTuiChat(ctx, Object.assign({
    ...options.omitWelcome === true ? {} : { welcome: 'Coding agent ready.' },
    sessionId,
    theme: { color: false },
  }, options.config), {
    terminal,
    exit,
    // Default to the real clock (runtime.now falls back to Date.now) so the
    // elapsed-status suites can drive time via timers or Date.now spies; a
    // test pins the clock only by passing `now` explicitly.
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.formatCwd === undefined ? {} : { formatCwd: options.formatCwd }),
    ...(options.handoffResume === undefined ? {} : { handoffResume: options.handoffResume }),
    ...(options.handoffNew === undefined ? {} : { handoffNew: options.handoffNew }),
    ...(options.goodbyeMessage === undefined ? {} : { goodbyeMessage: options.goodbyeMessage }),
    gitBranch: options.gitBranch ?? (() => 'tui-staging'),
  })
  return { ctx, session, agent, terminal, exit, controller }
}

/** Dispose the mounted TUI before its owning Cordis context. */
export async function disposeTuiTestHarness(
  setup: Pick<TuiHarness<Terminal, (code: number) => void>, 'controller' | 'ctx'>,
): Promise<void> {
  await setup.controller.dispose()
  await setup.ctx.fiber.dispose()
}

/** Append a production-shaped user message to the active session surface. */
export function appendUser(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/**
 * Adapt the tests' simplified persistence fixture (`list`/`load`) to the rc.2
 * handle-based `SessionPersistence` service shape consumed by the real
 * `SessionQueryEngine`.
 */
function adaptSessionPersistence(fixture: NonNullable<TuiHarnessOptions['sessionPersistence']>) {
  const identity = Symbol('test-session-persistence')
  // rc.2 opens a log handle directly by id, so an open must not re-run the
  // fixture's `list` (some fixtures make listing observable and return
  // different records per call). The latest listing/stat observation only
  // supplies the header for load-less fixtures.
  let latest = new Map<string, SessionHeader>()
  const remember = (headers: readonly SessionHeader[]): void => {
    latest = new Map(headers.map(header => [String(header.id), header]))
  }
  const openHandle = async (id: ReturnType<typeof SessionId>) => {
    const loaded = fixture.load === undefined ? undefined : await fixture.load(id)
    const header = loaded?.meta ?? latest.get(String(id))
    if (header === undefined) throw new Error(`session "${id}" not found`)
    const events = loaded?.events ?? []
    return {
      id,
      header,
      inheritedEventCount: 0,
      access: 'read' as const,
      async read() {
        return { eventState: 'detached' as const, events }
      },
      async append() {},
      async flush() {},
      async close() {},
    }
  }
  return {
    identity,
    async create(header: SessionHeader) {
      return {
        id: header.id,
        header,
        inheritedEventCount: 0,
        access: 'write' as const,
        async read() {
          return { eventState: 'detached' as const, events: [] as readonly SessionEvent[] }
        },
        async append() {},
        async flush() {},
        async close() {},
      }
    },
    open: (id: ReturnType<typeof SessionId>) => openHandle(id),
    async flush() {},
    async stat(id: ReturnType<typeof SessionId>) {
      const headers = await fixture.list()
      remember(headers)
      const header = headers.find(candidate => candidate.id === id)
      return header === undefined ? undefined : { header, revision: Symbol() }
    },
    async list() {
      const headers = await fixture.list()
      remember(headers)
      return headers.map(header => ({ header, revision: Symbol() }))
    },
  }
}

/** Emit one process-local live assistant-stream frame for an agent. */
export function emitAssistantFrame(ctx: Context, agent: Agent, frame: AssistantStreamFrame): void {
  agentEvents(ctx, agent).emit('agent/assistant-stream', { frame })
}

/** Parameters for the start-plus-chunks live-stream convenience helper. */
export interface EmitAssistantChunksOptions {
  turn: number
  step: number
  /** Timed chunks in dense order; frame indices are assigned from zero. */
  records: readonly { time: number; chunk: StreamChunk }[]
  attemptId?: LlmAttemptId
}

/**
 * Emit one live attempt: the `start` frame followed by one `chunk` frame per
 * record (dense indices from zero, revision 0). No `end` frame is emitted, so
 * the step stays open until a later frame or durable settlement — matching the
 * pre-rc.2 test scenarios that appended raw `assistant/chunk` events.
 */
export function emitAssistantChunks(
  ctx: Context,
  agent: Agent,
  options: EmitAssistantChunksOptions,
): void {
  const attemptId = options.attemptId ?? LlmAttemptId('attempt-1')
  emitAssistantFrame(ctx, agent, {
    type: 'start',
    attemptId,
    revision: 0,
    turn: options.turn,
    step: options.step,
  })
  options.records.forEach((record, index) => {
    emitAssistantFrame(ctx, agent, {
      type: 'chunk',
      attemptId,
      revision: 0,
      index,
      time: record.time,
      chunk: record.chunk,
    })
  })
}

/** Append a production-shaped assistant message to the active session surface. */
export function appendAssistant(
  session: Session,
  content: ContentBlock[],
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
  position: { turn: number; step: number } = { turn: 1, step: 1 },
): void {
  const now = Date.now()
  // rc.2 embeds the attempt's compact stream record in the durable event. The
  // settled content already lives in `message`; one block-start record per
  // content block is enough for replay-side timing/phase reconstruction.
  const stream = content.map((block, index) => ({
    type: 'chunk' as const,
    time: now + index,
    chunk: { type: 'block-start' as const, index, blockType: block.type },
  }))
  session.append('assistant/message', {
    ...position,
    message: createMessage({
      role: 'assistant',
      content,
      source: { kind: 'model', provider: 'mock', model: 'deepseek-v4-flash' },
    }),
    stream,
    ...usage === undefined ? {} : { usage },
  }, { surfaceOp: 'append' })
}
