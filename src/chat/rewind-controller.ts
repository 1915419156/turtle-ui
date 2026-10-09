/**
 * Rewind/fork sub-controller for the interactive chat channel: the double-Esc
 * restore-point picker and the in-place handoff that opens the fork.
 *
 * A fork is a real child session: it inherits an exact prefix of this session's
 * log (with an open tail closed by synthetic forked results), is persisted under
 * its own id, and is opened by re-execing the launcher in this workspace. The
 * source session is never mutated, so forking is always safe to repeat.
 * @module @deepseek-ai/dsh-tui/chat/rewind-controller
 */

import { randomUUID } from 'node:crypto'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import { buildForkSeed } from '@deepseek-ai/dsh-session/fork'
import type { TUI } from '@earendil-works/pi-tui'
import type { TuiOverlaySession } from '../extension/types.ts'
import type { HintEditor } from './helpers.ts'
import type { TuiRuntime } from '../runtime.ts'
import type { ChatChannelDeps, ChannelNotice } from './channel.ts'
import { RewindPicker } from '../components/rewind-picker.ts'
import { deriveRestorePoints, type RestorePoint } from './rewind.ts'

/** Collaborators the rewind controller needs from the chat channel. */
export interface RewindControllerDeps extends ChatChannelDeps, ChannelNotice {
  readonly agent: Agent
  readonly runtime: TuiRuntime
  readonly ui: TUI
  readonly editor: HintEditor
}

/** Rewind/fork controller for one chat channel. */
export interface RewindController {
  /** Open the restore-point picker when idle; report why not otherwise. */
  showRewind(): void
  /** Whether the host could open a fork at all (a launcher handoff is present). */
  available(): boolean
}

/** Milliseconds within which a second Esc counts as a double-tap. */
export const DOUBLE_ESCAPE_WINDOW_MS = 500

/**
 * Build the rewind controller.
 * @param deps - channel collaborators, terminal handles, and the host handoff.
 * @returns the controller wired to the double-Esc gesture.
 */
export function createRewindController(deps: RewindControllerDeps): RewindController {
  const { ctx, agent, runtime, resolved, palette, overlayManager, ui, editor } = deps
  const t = deps.translator.t
  let overlay: TuiOverlaySession | undefined
  let inFlight = false

  const forkId = (): SessionId => SessionId(`session-${randomUUID()}`)

  /**
   * Create the child session and open it in place. The child is created first
   * and disposed again if the handoff refuses, so a failed fork leaves neither
   * a stray live agent nor a half-written store row.
   */
  const forkAt = async (point: RestorePoint, session: TuiOverlaySession): Promise<void> => {
    if (inFlight) return
    inFlight = true
    let handle: AgentHandle | undefined
    let terminalReleased = false
    try {
      const handoff = runtime.handoffResume
      /* v8 ignore next -- showRewind refuses to open the picker without a handoff */
      if (handoff === undefined) throw new Error(t('rewind.hostCannotOpen'))
      const status = agent.status
      if (status !== 'idle') throw new Error(t('rewind.requiresIdleStatus', { status }))

      const source = agent.session
      const events = source.snapshotEvents()
      const boundary = point.boundary
      const seed = boundary < 0 ? [] : buildForkSeed(events, SessionSeq(boundary))
      const inheritedEventCount = boundary < 0 ? 0 : boundary + 1
      const cwd = source.header.cwd ?? process.cwd()
      const route = agent.options

      handle = await ctx.agents.create({
        sessionId: forkId(),
        seed,
        inheritedEventCount: SessionLogOffset(inheritedEventCount),
        meta: {
          cwd,
          parentSession: source.header.id,
          isSeeded: true,
        },
        agentOptions: {
          ...route.provider === undefined ? {} : { provider: route.provider },
          ...route.model === undefined ? {} : { model: route.model },
          ...route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort },
        },
      })
      if (deps.isDisposed()) return
      // Durability before the handoff: the replacement process reads this log
      // from storage, not from this process's memory.
      await ctx.sessions.flush(handle.agent.session)
      if (deps.isDisposed()) return
      if (agent.status !== 'idle') throw new Error(t('rewind.requiresIdleStatus', { status: agent.status }))

      const childSessionId = handle.agent.session.id
      await session.close()
      await runtime.terminal.drainInput(100, 20)
      if (deps.isDisposed()) return
      ui.stop()
      terminalReleased = true
      await handoff(childSessionId, cwd)
      throw new Error(t('rewind.hostReturned'))
    } catch (error: unknown) {
      // The child is live only in this process; the handoff owns it once it
      // commits, so a failure here must retire it before reporting.
      if (handle !== undefined) {
        await handle.dispose().catch(
          /* v8 ignore next 2 -- a dispose failure cannot change the reported cause */
          () => {},
        )
      }
      if (!deps.isDisposed()) {
        if (terminalReleased) {
          ui.start()
          ui.setFocus(editor)
        } else {
          await session.close().catch(
            /* v8 ignore next 2 -- the overlay may already be closed by the failed path */
            () => {},
          )
        }
        deps.appendNotice(t('rewind.failed', { error: errorChain(error) }), 'error')
        deps.requestRender()
      }
    } finally {
      inFlight = false
    }
  }

  return {
    available(): boolean {
      return runtime.handoffResume !== undefined
    },
    showRewind(): void {
      if (!this.available()) {
        deps.appendNotice(t('rewind.hostUnsupported'), 'warning')
        return
      }
      if (agent.status !== 'idle') {
        deps.appendNotice(t('rewind.requiresIdle'), 'warning')
        return
      }
      const points = deriveRestorePoints(agent.session, deps.translator)
      if (points.length === 0) {
        deps.appendNotice(t('rewind.noEvents'), 'warning')
        return
      }
      void overlay?.close()
      const session = overlayManager.open({
        create: () => new RewindPicker(
          points,
          resolved.maxResumeOptions,
          palette,
          (point) => { void forkAt(point, session) },
          () => { void session.close() },
          deps.translator,
        ),
        options: {
          // Wider than the model dialog: each row carries a turn label plus the
          // prompt and what the fork keeps, so the description needs the columns.
          width: Math.min(resolved.modelDialogWidth + 24, runtime.terminal.columns),
          maxHeight: resolved.modelDialogMaxHeight,
          anchor: 'center',
          margin: 1,
        },
      })
      overlay = session
      void session.closed.then(() => {
        if (overlay === session) overlay = undefined
      })
      deps.requestRender()
    },
  }
}
