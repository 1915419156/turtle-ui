/**
 * Session-operations sub-controller: `/doctor` (environment self-check),
 * `/cost` (token accounting, with an optional configured price table), and
 * `/mcp` (MCP tool inventory derived from the live tool registry).
 *
 * Every probe reads a service the TUI already injects or an optional service
 * through the non-throwing `ctx.get`, so the surfaces degrade to an explicit
 * "not mounted" line instead of failing when a composition omits a seam.
 * @module @deepseek-ai/dsh-tui/chat/diagnostics
 */

import { statfs } from 'node:fs/promises'
import { availableParallelism, freemem, platform, release, totalmem } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { Palette } from '../components/theme.ts'
import { displayText } from '../components/text.ts'
import {
  formatDiagnosticNumber,
  type StatusCardRow,
} from '../components/dialogs.ts'
import { cacheHitRate, sessionTokens } from './tokens.ts'
import { formatThroughput, type ThroughputTracker } from './throughput.ts'
import type { ToolCardVisibility } from '../components/transcript.ts'
import type { Translator } from '../i18n/translate.ts'

/** Price of one million tokens for one model route, in the deployment's currency unit. */
export interface ModelPrice {
  /** Provider route key, or `*` to match any provider. */
  provider?: string
  /** Model id, or `*` to match any model. */
  model?: string
  /** Price per million uncached input tokens. */
  input: number
  /** Price per million output tokens. */
  output: number
  /** Price per million cache-read tokens; defaults to the input price. */
  cacheRead?: number
  /** Price per million cache-write tokens; defaults to the input price. */
  cacheWrite?: number
}

/** Currency symbol prefixed to a computed cost. */
export const DEFAULT_CURRENCY = '$'

/** One token bucket's amount and its price, for cost arithmetic. */
interface PricedBucket {
  tokens: number
  pricePerMillion: number
}

/**
 * Find the price entry matching one route, preferring the most specific entry.
 *
 * An entry missing `input` or `output` is skipped rather than matched: the
 * Loader schema requires both, but a direct caller can hand `resolveTuiConfig`
 * an unchecked value, and a half-configured row would otherwise reach
 * {@link formatCost} as `undefined`.
 */
export function matchPrice(
  prices: readonly ModelPrice[],
  provider: string | undefined,
  model: string | undefined,
): ModelPrice | undefined {
  let best: ModelPrice | undefined
  let bestRank = -1
  for (const price of prices) {
    if (typeof price.input !== 'number' || typeof price.output !== 'number') continue
    const providerMatches = price.provider === undefined || price.provider === '*' || price.provider === provider
    const modelMatches = price.model === undefined || price.model === '*' || price.model === model
    if (!providerMatches || !modelMatches) continue
    const rank = (price.provider === undefined || price.provider === '*' ? 0 : 1)
      + (price.model === undefined || price.model === '*' ? 0 : 2)
    if (rank > bestRank) {
      bestRank = rank
      best = price
    }
  }
  return best
}

/**
 * Compute an estimated cost from token buckets.
 * @param buckets - Token amounts and their per-million prices.
 * @returns The summed cost.
 */
export function estimateCost(buckets: readonly PricedBucket[]): number {
  return buckets.reduce((total, bucket) =>
    total + (bucket.tokens / 1_000_000) * bucket.pricePerMillion, 0)
}

/**
 * Format a cost with the deployment currency, keeping sub-cent amounts visible.
 * @param value - Cost in the currency unit.
 * @param currency - Currency symbol.
 * @returns The formatted amount, e.g. `$0.0123`.
 */
export function formatCost(value: number, currency: string = DEFAULT_CURRENCY): string {
  if (value === 0) return `${currency}0`
  if (value < 0.01) return `${currency}${value.toFixed(4)}`
  if (value < 1) return `${currency}${value.toFixed(3)}`
  return `${currency}${value.toFixed(2)}`
}

/** MCP tool name prefix: `mcp__<server>__<tool>`. */
export const MCP_TOOL_PREFIX = 'mcp__'

/** One MCP server's tools, grouped for `/mcp`. */
export interface McpServerTools {
  /** Server namespace carried in the tool names. */
  readonly server: string
  /** Raw tool names under that server, in registry order. */
  readonly tools: readonly string[]
}

/**
 * Split `mcp__<server>__<tool>` names into per-server groups. A name that does
 * not follow the two-underscore convention is grouped under its raw name with an
 * empty tool list, so a foreign registration is reported rather than dropped.
 * @param names - Registered tool names.
 * @returns Per-server groups in first-seen order.
 */
export function groupMcpTools(names: readonly string[]): McpServerTools[] {
  const groups = new Map<string, string[]>()
  for (const name of names) {
    if (!name.startsWith(MCP_TOOL_PREFIX)) continue
    const rest = name.slice(MCP_TOOL_PREFIX.length)
    const separator = rest.indexOf('__')
    const server = separator < 0 ? rest : rest.slice(0, separator)
    const tool = separator < 0 ? '' : rest.slice(separator + 2)
    const existing = groups.get(server)
    if (existing === undefined) groups.set(server, tool === '' ? [] : [tool])
    else if (tool !== '') existing.push(tool)
  }
  return [...groups.entries()].map(([server, tools]) => ({ server, tools }))
}

/** Collaborators the session-operations controller needs. */
export interface DiagnosticsControllerDeps {
  readonly ctx: Context
  readonly agent: Agent
  readonly palette: Palette
  /** Append already-styled transcript lines through the channel's own notice path. */
  readonly appendSection: (title: string, rows: readonly StatusCardRow[], lines?: readonly string[]) => void
  /** Append a plain notice line. */
  readonly notice: (message: string, kind?: 'info' | 'warning' | 'error') => void
  /** Current model price table, re-read per invocation so a config reload applies. */
  readonly prices: () => readonly ModelPrice[]
  /** Currency symbol for computed costs. */
  readonly currency: () => string
  /** Live throughput tracker, for the doctor's rate line. */
  readonly throughput: () => ThroughputTracker
  /** Active tool-card visibility, reported by the doctor. */
  readonly toolsVisibility: () => ToolCardVisibility
  /** Whether reasoning blocks are rendered, reported by the doctor. */
  readonly showReasoning: () => boolean
  /** Active transcript render mode label, reported by the doctor. */
  readonly renderMode: () => string
  /** Monotonic-enough clock, for throughput sampling. */
  readonly now: () => number
  readonly isDisposed: () => boolean
  /** Locale for the cards, rows, and notices this controller renders. */
  readonly translator: Translator
}

/** Session-operations controller for one chat channel. */
export interface DiagnosticsController {
  /** Run `/doctor`: an environment self-check card. */
  runDoctor(): void
  /** Run `/cost [--json]`: token accounting and an optional cost estimate. */
  runCost(raw: string): void
  /** Run `/mcp`: MCP server and tool inventory. */
  runMcp(): void
}

/** Format a byte count with binary units. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? Math.round(value).toString() : value.toFixed(1)} ${units[unit] ?? 'B'}`
}

/** Human label for the runtime platform. */
function platformLabel(): string {
  return `${platform()} ${release()}`
}

/** First line of a definition's description, or `undefined` when it has none. */
function descriptionLine(definition: ToolDefinition | undefined): string | undefined {
  const description = definition?.description
  return description === undefined ? undefined : displayText(description.split('\n')[0] ?? '')
}

/**
 * Build the session-operations controller.
 * @param deps - channel collaborators and the live service reads.
 * @returns the controller wired to `/doctor`, `/cost`, and `/mcp`.
 */
export function createDiagnosticsController(deps: DiagnosticsControllerDeps): DiagnosticsController {
  const { ctx, agent, palette } = deps
  const t = deps.translator.t

  const sessionOf = (): Session => agent.session

  const runDoctor = (): void => {
    const session = sessionOf()
    const tokens = sessionTokens(session)
    const events = session.snapshotEvents()
    const latest = events.at(-1)
    const groups: StatusCardRow[][] = []
    const warnings: string[] = []

    // Runtime
    const memory = t('doctor.memoryUsed', {
      used: formatBytes(totalmem() - freemem()),
      total: formatBytes(totalmem()),
    })
    groups.push([
      [t('doctor.label.node'), process.version],
      [t('doctor.label.platform'), platformLabel()],
      [t('doctor.label.cpu'), t('doctor.cores', { count: availableParallelism() })],
      [t('doctor.label.memory'), memory],
      [t('doctor.label.terminal'), `pid ${process.pid}`],
    ])

    // Session and agent
    const status = agent.status
    if (status !== 'idle') warnings.push(t('doctor.agentMoving', { status }))
    groups.push([
      [t('doctor.label.session'), displayText(String(session.id))],
      [t('doctor.label.workspace'), displayText(session.header.cwd ?? t('doctor.unset'))],
      [t('doctor.label.agent'), status],
      [t('doctor.label.events'), formatDiagnosticNumber(events.length)],
      [t('doctor.label.lastEvent'), latest === undefined
        ? t('doctor.noEvents')
        : `${latest.type} @ ${new Date(latest.time).toISOString()}`],
    ])

    // Model route
    const route = agent.options
    const provider = route.provider
    const model = route.model
    const price = matchPrice(deps.prices(), provider, model)
    groups.push([
      [t('doctor.label.provider'), displayText(provider ?? t('doctor.unset'))],
      [t('doctor.label.model'), displayText(model ?? t('doctor.unset'))],
      [t('doctor.label.reasoning'), provider === undefined
        ? t('common.na')
        : displayText(route.reasoningEffort ?? t('common.default'))],
      [t('doctor.label.pricing'), price === undefined
        ? t('doctor.pricingUnconfigured')
        : t('doctor.pricingConfigured')],
    ])

    // Services the TUI reads optionally
    const mounted = (name: string): string =>
      ctx.get(name as never, false) === undefined ? t('doctor.notMounted') : t('doctor.mounted')
    const serviceRows: StatusCardRow[] = [
      [t('doctor.label.commands'), mounted('commands')],
      [t('doctor.label.skills'), mounted('skills')],
      [t('doctor.label.sessionQuery'), mounted('sessionQuery')],
      [t('doctor.label.persistence'), mounted('sessionPersistence')],
      [t('doctor.label.workspaceRegistry'), mounted('workspaceRegistry')],
      [t('doctor.label.sessionReference'), mounted('sessionReferenceResolver')],
      [t('doctor.label.projections'), mounted('sessionProjections')],
      [t('doctor.label.projectionCache'), mounted('sessionProjectionCache')],
      [t('doctor.label.loader'), mounted('loader')],
      // Not a service but the same class of capability: the launcher-provided
      // keys gate `/resume`, `/new`, the rewind fork handoff, and the exit line.
      [t('doctor.label.resumeHost'), mounted('tuiResumeHost')],
    ]
    groups.push(serviceRows)
    for (const [name, value] of serviceRows) {
      if (value === t('doctor.notMounted')) warnings.push(t('doctor.serviceReduced', { name }))
    }

    // Transcript presentation
    const tokensPerSecond = deps.throughput().tokensPerSecond(deps.now())
    groups.push([
      [t('doctor.label.renderMode'), deps.renderMode()],
      [t('doctor.label.toolCards'), t(`details.phase.${deps.toolsVisibility()}`)],
      [t('doctor.label.reasoningBlocks'), t(deps.showReasoning() ? 'common.shown' : 'common.hidden')],
      [t('doctor.label.toolSchemas'), String(ctx.tools.schemas(agent).length)],
      [t('doctor.label.tps'), tokensPerSecond === undefined
        ? t('common.na')
        : formatThroughput(tokensPerSecond)],
    ])

    // Token accounting
    const rate = cacheHitRate(tokens)
    groups.push([
      [t('doctor.label.input'), formatDiagnosticNumber(tokens.input)],
      [t('doctor.label.output'), formatDiagnosticNumber(tokens.output)],
      [t('doctor.label.cacheRead'), formatDiagnosticNumber(tokens.cacheRead)],
      [t('doctor.label.cacheWrite'), formatDiagnosticNumber(tokens.cacheWrite)],
      [t('doctor.label.cacheHitRate'), rate === undefined ? t('common.na') : `${String(rate)}%`],
    ])

    void collectDisk(deps, session)
      .then((disk) => {
        if (deps.isDisposed()) return
        if (disk !== undefined) groups.push([[t('doctor.label.disk'), disk]])
        deps.appendSection(
          t('doctor.title'),
          groups.flat(),
          warnings.length === 0 ? undefined : warnings.map(warning => `! ${warning}`),
        )
      })
  }

  const runCost = (raw: string): void => {
    const argument = raw.trim().toLowerCase()
    if (argument !== '' && argument !== '--json') {
      deps.notice(t('cost.usage'), 'warning')
      return
    }
    const session = sessionOf()
    const tokens = sessionTokens(session)
    const route = agent.options
    const price = matchPrice(deps.prices(), route.provider, route.model)
    const rate = cacheHitRate(tokens)
    const rows: StatusCardRow[] = [
      [t('cost.label.inputUncached'), formatDiagnosticNumber(tokens.input)],
      [t('doctor.label.cacheRead'), formatDiagnosticNumber(tokens.cacheRead)],
      [t('doctor.label.cacheWrite'), formatDiagnosticNumber(tokens.cacheWrite)],
      [t('doctor.label.output'), formatDiagnosticNumber(tokens.output)],
      [t('cost.label.stepsBilled'), formatDiagnosticNumber(tokens.byStep.size)],
      [t('doctor.label.cacheHitRate'), rate === undefined ? t('common.na') : `${String(rate)}%`],
    ]
    if (price === undefined) {
      rows.push([t('cost.label.cost'), t('cost.notConfigured')])
      deps.appendSection(t('cost.title'), rows, [t('cost.noPriceTable'), t('cost.addPrices')])
      return
    }
    const cacheReadPrice = price.cacheRead ?? price.input
    const cacheWritePrice = price.cacheWrite ?? price.input
    const total = estimateCost([
      { tokens: tokens.input, pricePerMillion: price.input },
      { tokens: tokens.cacheRead, pricePerMillion: cacheReadPrice },
      { tokens: tokens.cacheWrite, pricePerMillion: cacheWritePrice },
      { tokens: tokens.output, pricePerMillion: price.output },
    ])
    const currency = deps.currency()
    // Labels stay short: the status card clips its label column to a third of
    // its inner width, so a long name would render as an ellipsis.
    const pricedRow = (label: string, amount: number, unitPrice: number): StatusCardRow => [
      label,
      t('cost.unitPrice', {
        amount: formatDiagnosticNumber(amount),
        price: formatCost(unitPrice, currency),
      }),
    ]
    rows.push(
      pricedRow(t('cost.label.inPrice'), tokens.input, price.input),
      pricedRow(t('cost.label.outPrice'), tokens.output, price.output),
      pricedRow(t('cost.label.cachedRead'), tokens.cacheRead, cacheReadPrice),
      pricedRow(t('cost.label.cachedWrite'), tokens.cacheWrite, cacheWritePrice),
      [t('cost.label.total'), palette.bold(formatCost(total, currency))],
    )
    if (argument === '--json') {
      deps.appendSection(t('cost.title'), rows, [JSON.stringify({
        sessionId: String(session.id),
        provider: route.provider,
        model: route.model,
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
        steps: tokens.byStep.size,
        cacheHitRate: rate,
        currency,
        estimatedCost: total,
      })])
      return
    }
    deps.appendSection(t('cost.title'), rows, [
      t('cost.pricesAreConfig', {
        input: formatCost(price.input, currency),
        output: formatCost(price.output, currency),
      }),
    ])
  }

  const runMcp = (): void => {
    const names = ctx.tools.schemas(agent).map(schema => schema.name)
    const groups = groupMcpTools(names)
    if (groups.length === 0) {
      deps.notice(t('mcp.empty'), 'info')
      return
    }
    const rows: StatusCardRow[] = []
    const body: string[] = []
    for (const group of groups) {
      rows.push([group.server, t('mcp.toolCount', { count: group.tools.length })])
      const definitions = group.tools.map(tool => ctx.tools.get(`${MCP_TOOL_PREFIX}${group.server}__${tool}`, agent))
      const lines = group.tools.map((tool, index) => {
        const summary = descriptionLine(definitions[index])
        return `  ${displayText(tool)}${summary === undefined ? '' : ` — ${summary}`}`
      })
      // Body lines are plain text: the channel escapes and tones every line it
      // renders, so a palette call here would be escaped into literal
      // `\x1b[..m` text. Server and tool names come from an external process,
      // so escaping is the point rather than an inconvenience.
      body.push(displayText(group.server), ...(lines.length === 0 ? [t('mcp.noTools')] : lines), '')
    }
    deps.appendSection(t('mcp.title'), rows, body)
  }

  return { runDoctor, runCost, runMcp }
}

/**
 * Read workspace filesystem capacity for the doctor card. Failure is expected on
 * exotic filesystems and simply omits the row.
 */
async function collectDisk(deps: DiagnosticsControllerDeps, session: Session): Promise<string | undefined> {
  const cwd = session.header.cwd ?? process.cwd()
  try {
    const info = await statfs(cwd)
    const total = info.blocks * info.bsize
    const free = info.bfree * info.bsize
    return deps.translator.t('doctor.diskUsed', {
      used: formatBytes(total - free),
      total: formatBytes(total),
      free: formatBytes(free),
    })
  } catch (error: unknown) {
    /* v8 ignore next -- a statfs failure is environment-dependent; the degradation itself is covered by the missing-service rows. */
    deps.ctx.logger.debug(`ui-tui: statfs failed for doctor: ${errorChain(error)}`)
    return undefined
  }
}
