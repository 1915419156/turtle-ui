/**
 * Session-resume sub-controller for the interactive chat channel: the
 * `/resume` selector, one metadata-plus-title scan that tolerates a corrupt
 * neighbor, the pre-handoff preflight, and the terminal handoff itself.
 * @module @deepseek-ai/dsh-tui/chat/resume
 */

import type { TUI } from '@earendil-works/pi-tui'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionCache } from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-session-title'
import type {
  SessionQueryEngine,
  SessionRecord,
} from '@deepseek-ai/dsh-session-query'
// The registry is optional (mounted only where a grouping surface exists), so
// its type is imported for the Context augmentation and read non-strictly.
import type WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { HintEditor } from './helpers.ts'
import { formatCwd } from './helpers.ts'
import type { TuiOverlaySession } from '../extension/types.ts'
import type { TuiRuntime } from '../runtime.ts'
import {
  ResumePicker,
  summarizeResumeCandidate,
  type ResumeArchiveRequest,
  type ResumeCandidate,
  type ResumeScope,
} from '../components/dialogs.ts'
import type { ChannelNotice, ChatChannelDeps } from './channel.ts'

/** Collaborators the resume controller needs from the chat channel. */
export interface ResumeControllerDeps extends ChatChannelDeps, ChannelNotice {
  readonly agent: Agent
  readonly runtime: TuiRuntime
  /**
   * The optional session-query service, re-read at each use. `sessionQuery` is
   * mounted by an independent plugin, and a flat config tree gives no ordering
   * guarantee between it and this front door, so a value captured once at
   * construction can be `undefined` even though the service arrives moments later.
   */
  readonly sessionQuery: (this: void) => SessionQueryEngine | undefined
  /**
   * The optional workspace registry, re-read at each use for the same ordering
   * reason. It owns the durable archive set the picker's archived scope lists
   * and where Ctrl+D hides or restores a session without deleting its log.
   */
  readonly workspaceRegistry: (this: void) => WorkspaceRegistry | undefined
  readonly ui: TUI
  readonly editor: HintEditor
  /** Current agent status, re-read at each resume precondition point. */
  agentStatus(): AgentStatus
}

/** Session-resume controller for one chat channel. */
export interface ResumeController {
  /** Open the searchable session selector, scoped to this workspace until the user widens it. */
  showResume(scope?: ResumeScope): void
  /** Hand this process off to a fresh session in the current workspace. */
  startNew(): void
}

/**
 * Build the session-resume controller for one chat channel.
 * @param deps - channel collaborators, terminal handles, and optional services.
 * @returns the controller wired to the `/resume` command.
 */
export function createResumeController(deps: ResumeControllerDeps): ResumeController {
  const {
    ctx, agent, runtime, resolved, palette, overlayManager,
    sessionQuery, workspaceRegistry, ui, editor,
  } = deps
  let resumeOverlay: TuiOverlaySession | undefined
  let resumeInFlight = false
  let resumeScan = 0

  /** Label any session's own workspace the way the prompt labels the current one. */
  const workspaceLabel = (cwd: string | undefined): string =>
    runtime.formatCwd?.(cwd) ?? formatCwd(cwd)

  /** Summarize one record from metadata and its batch-folded title. */
  const summarize = (
    record: SessionRecord,
    title: string | undefined,
    lastActivityAt: number | undefined,
  ): ResumeCandidate => ({
    ...summarizeResumeCandidate(
      record,
      title,
      lastActivityAt,
      agent.session.id,
      agent.session.header.cwd,
      workspaceLabel,
    ),
    archived: ctx.get('workspaceRegistry', false)?.archivedSessionIds.includes(record.header.id) === true,
  })

  /** The disabled fallback row for a session whose title read failed. */
  const unreadableCandidate = (
    record: SessionRecord,
    lastActivityAt: number | undefined,
    error: unknown,
  ): ResumeCandidate => ({
    record,
    title: 'Unreadable session',
    lastActivityAt: lastActivityAt ?? record.header.createdAt,
    currentWorkspace: record.header.cwd === agent.session.header.cwd,
    workspaceLabel: workspaceLabel(record.header.cwd),
    archived: ctx.get('workspaceRegistry', false)?.archivedSessionIds.includes(record.header.id) === true,
    disabledReason: `session cannot be loaded: ${errorChain(error)}`,
  })

  /**
   * A live session's last in-memory event time; `undefined` for persisted
   * rows. Persisted activity comes from the scan's title read instead (the
   * title snapshot's `updatedAt`), so browsing costs one read per row with no
   * separate log pass; a titleless log falls back to created-at.
   */
  const liveActivityAt = (record: SessionRecord): number | undefined =>
    ctx.sessions.get(record.header.id)?.snapshotEvents().at(-1)?.time

  /**
   * One persisted row's title through the projection-cache ladder: the
   * zero-I/O checkpoint row when usable, otherwise a read of the stored log
   * that folds the projections and writes the refreshed row back — so a store
   * scanned once serves later scans from the checkpoint without another read.
   */
  const projectedTitle = async (
    cache: SessionProjectionCache,
    listQuery: SessionQueryEngine,
    record: SessionRecord,
  ): Promise<string | null | undefined> => {
    const live = ctx.sessions.get(record.header.id)
    if (live !== undefined) return ctx.get('sessionProjections')?.snapshot(live).values.title
    const cached = cache.cachedSnapshot(record.header)
    if (cached !== undefined && 'title' in cached.values) return cached.values.title
    // Since 0.2.0 the cache never reads logs itself: the cold fold takes the
    // complete log the caller supplies. `readSession` replay-validates, so a
    // corrupt neighbor rejects and degrades its row instead of the whole scan.
    const log = await listQuery.readSession(record.header.id)
    return cache.coldSnapshot(log.session, log.inheritedEventCount, log.events).values.title
  }

  /** One per-record resolution: a title with its activity time, or an isolated failure. */
  type TitleResolution = { title?: string; activity?: number; failure?: unknown }

  /**
   * Resolve every row's title and activity time without reading whole logs when
   * the projection cache is mounted (live registry snapshot / checkpoint row /
   * full-log cold fold, bounded by `resumeScanConcurrency`); a composition
   * without the cache falls back to one bounded raw-log title batch whose title
   * snapshot carries the row's activity time (`updatedAt`).
   */
  const resolveTitles = async (
    listQuery: SessionQueryEngine,
    records: readonly SessionRecord[],
    signal: AbortSignal,
  ): Promise<TitleResolution[]> => {
    const cache = ctx.get('sessionProjectionCache')
    if (cache === undefined) {
      const results = await listQuery.readTitleSnapshots(records.map(record => record.header.id), signal)
      return records.map((record, index): TitleResolution => {
        const result = results[index]
        /* v8 ignore next 2 -- readTitleSnapshots returns one result per unique listed id in input order */
        if (result === undefined || result.sessionId !== record.header.id) throw new Error(`resume scan misaligned at "${record.header.id}"`)
        if (result.status === 'rejected') return { failure: result.reason }
        const title = result.value.title?.title
        const activity = result.value.title?.updatedAt
        return title === undefined && activity === undefined
          ? {}
          : { ...(title === undefined ? {} : { title }), ...(activity === undefined ? {} : { activity }) }
      })
    }
    const resolutions = new Array<TitleResolution>(records.length)
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor
        if (index >= records.length) return
        cursor += 1
        const record = records[index] as SessionRecord
        try {
          const value = await projectedTitle(cache, listQuery, record)
          resolutions[index] = typeof value === 'string' ? { title: value } : {}
        } catch (failure: unknown) {
          resolutions[index] = { failure }
        }
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(resolved.resumeScanConcurrency, records.length) },
      () => worker(),
    ))
    return resolutions
  }

  /** The latest logged provider/model route, for the preflight availability check. */
  const resumeRoute = (events: readonly SessionEvent[]): { provider: string; model: string } | undefined => {
    const header = events.findLast(item => item.type === 'request/header')
    if (header?.type === 'request/header') {
      return { provider: header.data.header.config.provider, model: header.data.header.config.model }
    }
    const assistant = events.findLast(item => item.type === 'assistant/message')
    return assistant?.type === 'assistant/message'
      ? { provider: assistant.data.message.source.provider, model: assistant.data.message.source.model }
      : undefined
  }

  /**
   * Re-read every mutable precondition immediately before terminal handoff and
   * resolve the exact identity and workspace the host will re-exec into. This
   * is where the one chosen log is fully read, replay-validated, and checked
   * for a currently-available route — the listing never does any of that.
   */
  const preflightResume = async (sessionId: SessionId): Promise<{ id: SessionId; cwd: string }> => {
    const query = sessionQuery()
    /* v8 ignore start -- showResume alone calls this after proving the optional service exists */
    if (query === undefined) throw new Error('Resume is unavailable: session query is not mounted.')
    /* v8 ignore stop */
    const initialStatus = deps.agentStatus()
    if (initialStatus !== 'idle') throw new Error(`Resume requires an idle agent (status: ${initialStatus}).`)
    const record = (await query.listSessions()).find(candidate => candidate.header.id === sessionId)
    if (record === undefined) throw new Error(`Session "${sessionId}" is no longer available.`)
    const candidate = summarize(record, undefined, undefined)
    if (candidate.disabledReason !== undefined) throw new Error(candidate.disabledReason)
    let events: readonly SessionEvent[]
    try {
      events = (await query.readSession(record.header.id)).events
    } catch (error: unknown) {
      throw new Error(`session cannot be loaded: ${errorChain(error)}`)
    }
    const route = resumeRoute(events)
    if (route !== undefined && !ctx.llm.listProviders().some(provider => provider.id === route.provider)) {
      throw new Error(`session is complete, but route is currently unavailable (${route.provider}/${route.model})`)
    }
    const cwd = record.header.cwd
    /* v8 ignore next -- summarizeResumeCandidate disables a cwd-less record, so the check above already rejected it */
    if (cwd === undefined) throw new Error(`Session "${sessionId}" has no recorded workspace to resume in.`)
    const finalStatus = deps.agentStatus()
    if (finalStatus !== 'idle') throw new Error(`Resume requires an idle agent (status: ${finalStatus}).`)
    return { id: record.header.id, cwd }
  }

  const handoffResume = async (candidate: ResumeCandidate, overlay: TuiOverlaySession): Promise<void> => {
    if (resumeInFlight) return
    resumeInFlight = true
    let terminalReleased = false
    try {
      const checked = await preflightResume(candidate.record.header.id)
      const hostHandoff = runtime.handoffResume
      if (hostHandoff === undefined) {
        await overlay.close()
        resumeOverlay = undefined
        deps.appendNotice('Session is resumable, but this host cannot hand it off in place.', 'warning')
        return
      }
      /* v8 ignore next -- shutdown during preflight invalidates an awaited service read or reaches this guard */
      if (deps.isDisposed()) return
      await ctx.sessions.flush(agent.session)
      // Disposal can run while the flush promise is pending.
      if (deps.isDisposed()) return
      if (agent.status !== 'idle') throw new Error(`Resume requires an idle agent (status: ${agent.status}).`)
      await overlay.close()
      resumeOverlay = undefined
      await runtime.terminal.drainInput(100, 20)
      // Disposal can run while terminal draining is pending.
      if (deps.isDisposed()) return
      ui.stop()
      terminalReleased = true
      // The host re-execs into the session's own workspace: process cwd, not the
      // restored session header, is what the filesystem and shell tools resolve
      // against.
      await hostHandoff(checked.id, checked.cwd)
      throw new Error('resume host returned without replacing the process')
    } catch (error: unknown) {
      if (!deps.isDisposed()) {
        if (terminalReleased) {
          ui.start()
          ui.setFocus(editor)
          deps.appendNotice(`Resume handoff failed: ${errorChain(error)}`, 'error')
        } else {
          await overlay.close()
          resumeOverlay = undefined
          deps.appendNotice(`Resume failed: ${errorChain(error)}`, 'error')
        }
      }
    } finally {
      resumeInFlight = false
    }
  }

  /**
   * Hand the process off to a fresh session in the current workspace. The
   * replacement starts blank, so this is the one handoff that needs no
   * preflight against a stored log — but it still requires an idle agent, the
   * host capability, and a recorded workspace for the replacement's tools.
   */
  const handoffNew = async (): Promise<void> => {
    if (resumeInFlight) return
    resumeInFlight = true
    let terminalReleased = false
    try {
      const status = deps.agentStatus()
      if (status !== 'idle') throw new Error(`Starting a new session requires an idle agent (status: ${status}).`)
      const hostHandoff = runtime.handoffNew
      if (hostHandoff === undefined) {
        deps.appendNotice('This host cannot start a fresh session in place.', 'warning')
        return
      }
      const cwd = agent.session.header.cwd ?? process.cwd()
      if (deps.isDisposed()) return
      await ctx.sessions.flush(agent.session)
      if (deps.isDisposed()) return
      if (agent.status !== 'idle') throw new Error(`Starting a new session requires an idle agent (status: ${agent.status}).`)
      await resumeOverlay?.close()
      resumeOverlay = undefined
      await runtime.terminal.drainInput(100, 20)
      if (deps.isDisposed()) return
      ui.stop()
      terminalReleased = true
      await hostHandoff(cwd)
      throw new Error('resume host returned without replacing the process')
    } catch (error: unknown) {
      if (!deps.isDisposed()) {
        if (terminalReleased) {
          ui.start()
          ui.setFocus(editor)
          deps.appendNotice(`New session handoff failed: ${errorChain(error)}`, 'error')
        } else {
          deps.appendNotice(`New session failed: ${errorChain(error)}`, 'error')
        }
      }
    } finally {
      resumeInFlight = false
    }
  }

  /**
   * Archive or restore one session through the workspace registry and answer
   * with the durable archive set. The registry rejects an archive request for a
   * session with running work, which is the picker's "still live" error.
   */
  const setArchived = async ({ candidate, archived }: ResumeArchiveRequest): Promise<readonly SessionId[]> => {
    const registry = workspaceRegistry()
    /* v8 ignore next -- the picker hides the action without the registry, so this path needs a race */
    if (registry === undefined) throw new Error('Archiving needs the workspace registry, which this composition does not mount.')
    if (archived) await registry.archiveSession(candidate.record.header.id)
    else await registry.unarchiveSession(candidate.record.header.id)
    return [...registry.archivedSessionIds]
  }

  return {
    showResume(scope: ResumeScope = 'workspace'): void {
      if (agent.status !== 'idle') {
        deps.appendNotice('Resume requires the current turn to finish or be cancelled first.', 'warning')
        return
      }
      const listQuery = sessionQuery()
      if (listQuery === undefined) {
        deps.appendNotice('Resume is not available: session query is not mounted.', 'warning')
        return
      }
      if (scope === 'archived' && workspaceRegistry() === undefined) {
        deps.appendNotice('Archived sessions need the workspace registry, which this composition does not mount.', 'warning')
        return
      }
      const scan = ++resumeScan
      // The archived scope exists only where the registry does; an unbacked
      // Ctrl+D would promise a capability the composition cannot serve.
      const archiveAction = workspaceRegistry() === undefined ? undefined : setArchived
      void resumeOverlay?.close()
      // The picker opens before the scan settles so the terminal stops feeding
      // the editor immediately; a queued activation (the closing predecessor
      // still holds the slot) receives an already-scanned set through
      // `scanned` instead of a loading placeholder.
      let picker: ResumePicker | undefined
      let scanned: ResumeCandidate[] | undefined
      const session = overlayManager.open({
        create: (host) => {
          picker = new ResumePicker(
            scanned,
            resolved.maxResumeOptions,
            workspaceLabel(agent.session.header.cwd),
            () => host.viewport.rows,
            palette,
            (candidate) => { void handoffResume(candidate, session) },
            () => { void session.close() },
            archiveAction,
            () => { void handoffNew() },
            scope,
          )
          return picker
        },
        options: {
          width: '100%',
          maxHeight: '100%',
          anchor: 'top-left',
          margin: 0,
        },
      })
      resumeOverlay = session
      // Closing the picker — Escape, supersession, disposal — aborts the scan:
      // the borrowed-log pass over a large store must not outlive its overlay.
      const scanAbort = new AbortController()
      void session.closed.then(() => {
        scanAbort.abort()
        /* v8 ignore next -- overlay FIFO closes this session before a replacement can become the tracked resume overlay */
        if (resumeOverlay === session) resumeOverlay = undefined
      })
      deps.requestRender()
      /** Whether this scan's overlay, session generation, or TUI is gone. */
      const scanStale = (): boolean =>
        deps.isDisposed() || scan !== resumeScan || scanAbort.signal.aborted
      const scanCandidates = async (): Promise<void> => {
        // Every workspace in the store is listed; the picker owns the
        // current-workspace/all-workspaces scope split over the whole set.
        const records = await listQuery.listSessions(scanAbort.signal)
        if (scanStale()) return
        // Rows need only metadata, an activity time, and a title — resolved
        // without whole-log reads when the projection cache is mounted (the
        // title read doubles as the persisted activity source). A corrupt
        // neighbor degrades to one disabled row.
        const resolutions = await resolveTitles(listQuery, records, scanAbort.signal)
        const candidates = records.map((record, index) => {
          const resolution = resolutions[index] as TitleResolution
          const activity = liveActivityAt(record) ?? resolution.activity
          return 'failure' in resolution
            ? unreadableCandidate(record, activity, resolution.failure)
            : summarize(record, resolution.title, activity)
        })
        candidates.sort((a, b) => b.lastActivityAt - a.lastActivityAt
          || a.record.header.id.localeCompare(b.record.header.id))
        if (scanStale()) return
        scanned = candidates
        picker?.setCandidates(candidates)
        deps.requestRender()
      }
      // One catch covers listing, titles, and activity resolution, so a scan
      // failure cannot strand the overlay on its loading placeholder; an
      // aborted scan's rejection stays silent because the user already
      // dismissed the picker.
      void scanCandidates().catch((error: unknown) => {
        if (scanStale()) return
        void session.close()
        deps.appendNotice(`Resume session scan failed: ${errorChain(error)}`, 'error')
      })
    },
    startNew(): void {
      void handoffNew()
    },
  }
}
