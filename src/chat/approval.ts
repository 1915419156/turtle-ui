/**
 * Approval sub-machine for the interactive chat channel. It answers the
 * agent-scoped `approval/request` waterfall, presents one approval overlay at a
 * time in FIFO order, and settles each request on decision, abort, overlay
 * error, or channel shutdown.
 *
 * Every non-decision path resolves to a non-granting outcome: a withdrawn
 * request settles `cancelled` and an overlay that cannot be presented settles
 * `unavailable`, so the tool pipeline fails closed exactly as it does with no
 * answerer composed at all.
 * @module @deepseek-ai/dsh-tui/chat/approval
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import type { TuiOverlaySession } from '../extension/types.ts'
import { parseArguments } from '../components/content.ts'
import { ApprovalDialog } from '../components/dialogs.ts'
import type { ChatChannelDeps } from './channel.ts'

/** One queued or active approval request and the answer it is waiting on. */
interface PendingApproval {
  request: ApprovalRequestEvent
  resolve(outcome: ApprovalOutcome): void
  onAbort: () => void
  overlay: TuiOverlaySession | undefined
}

/** Collaborators the approval queue needs from the chat channel. */
export interface ApprovalQueueDeps extends ChatChannelDeps {
  /** The agent this terminal answers approval requests for; the waterfall is agent-scoped. */
  readonly agent: Agent
  /** Current row budget for the approval panel after reserving the editor. */
  approvalMaxHeight(): number
}

/** Approval controller for one chat channel. */
export interface ApprovalQueue {
  /** Withdraw the active and all queued requests (shutdown). */
  rejectAll(): void
  /** Remove the approval answerer registration. */
  unregister(): void
}

/**
 * Build the approval answerer for one chat channel.
 * @param deps - channel collaborators and the inline-panel row budget.
 * @returns the controller used at shutdown to drain and unregister.
 */
export function createApprovalQueue(deps: ApprovalQueueDeps): ApprovalQueue {
  const { agent, resolved, palette, overlayManager } = deps
  const queue: PendingApproval[] = []
  let active: PendingApproval | undefined

  const removeAbortListener = (pending: PendingApproval): void => {
    pending.request.signal?.removeEventListener('abort', pending.onAbort)
  }

  /** Close the pending request's overlay (if any) and settle it once. */
  const settle = (pending: PendingApproval, outcome: ApprovalOutcome): void => {
    removeAbortListener(pending)
    void pending.overlay?.close()
    pending.overlay = undefined
    pending.resolve(outcome)
  }

  const startNext = (): void => {
    if (active !== undefined || deps.isDisposed()) return
    const pending = queue.shift()
    if (pending === undefined) return
    active = pending
    let session: TuiOverlaySession
    try {
      session = overlayManager.open({
        ...pending.request.signal === undefined ? {} : { signal: pending.request.signal },
        create: () => new ApprovalDialog(
          pending.request.toolName,
          approvalReason(pending.request),
          attachedToolCall(pending.request),
          () => deps.approvalMaxHeight(),
          palette,
          (choice) => {
            if (active !== pending) return
            active = undefined
            settle(pending, choice)
            startNext()
          },
          () => {
            if (active !== pending) return
            active = undefined
            settle(pending, 'rejected')
            startNext()
          },
        ),
        // The approval panel occupies the same inline slot above the editor as
        // a question panel, so it shares that panel's size constraints.
        options: {
          width: resolved.questionDialogWidth,
          maxHeight: resolved.questionDialogMaxHeight,
        },
      }, 'inline')
    } catch {
      // The overlay host refuses new work once the TUI shuts down; an
      // unanswerable request must not hang the waterfall, so it fails closed.
      active = undefined
      settle(pending, 'unavailable')
      startNext()
      return
    }
    pending.overlay = session
    void session.closed.then((result) => {
      if (pending.overlay !== session) return
      pending.overlay = undefined
      /* v8 ignore next 2 -- close, abort, and shutdown settle the owner before this callback */
      if (result.reason !== 'error') return
      if (active === pending) active = undefined
      settle(pending, 'unavailable')
      startNext()
    })
    deps.requestRender()
  }

  const claim = (request: ApprovalRequestEvent): Promise<ApprovalOutcome> =>
    new Promise<ApprovalOutcome>((resolve) => {
      // A request that arrives after shutdown began has no prompt to show;
      // settling it immediately keeps the asker's waterfall moving instead of
      // hanging behind an unregister that is about to run.
      if (deps.isDisposed()) {
        resolve('unavailable')
        return
      }
      const pending: PendingApproval = {
        request,
        resolve,
        overlay: undefined,
        onAbort: () => {
          if (active === pending) {
            active = undefined
            settle(pending, 'cancelled')
            startNext()
            return
          }
          // A non-active pending request remains queued until this listener settles it.
          const index = queue.indexOf(pending)
          if (index >= 0) queue.splice(index, 1)
          settle(pending, 'cancelled')
        },
      }
      // The signal may have aborted between the service's pre-dispatch check and
      // this registration; `addEventListener` never fires for that case.
      if (request.signal?.aborted === true) {
        resolve('cancelled')
        return
      }
      request.signal?.addEventListener('abort', pending.onAbort, { once: true })
      queue.push(pending)
      startNext()
    })

  // The terminal claims every request for the one agent it drives by returning
  // a closed outcome from the agent-scoped waterfall; registering on the agent
  // scope both filters to that agent and unwinds the listener with this
  // channel. `unregister` remains the early detach handle.
  const unregister = agent.ctx.on('approval/request', request => claim(request))

  return {
    rejectAll(): void {
      if (active !== undefined) {
        const pending = active
        active = undefined
        settle(pending, 'cancelled')
      }
      for (const pending of queue.splice(0)) settle(pending, 'cancelled')
    },
    unregister,
  }
}

/** The asker's presentation text: localized display reason first, else the logged reason. */
function approvalReason(request: ApprovalRequestEvent): string | undefined {
  return request.displayReason?.en ?? request.reason
}

/**
 * The arguments of the tool call the asker attached, rendered as JSON. The
 * request itself never duplicates them — `callId` names the call already
 * presented as a transcript card — so a missing or unknown call id simply
 * renders no preview. The asking agent's own session is searched, because an
 * approval may belong to a delegated agent whose call never entered this
 * terminal's transcript.
 */
function attachedToolCall(request: ApprovalRequestEvent): string | undefined {
  const callId = request.callId
  if (callId === undefined) return undefined
  const events = request.agent.session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'tool/call' || event.data.callId !== callId) continue
    const parsed = parseArguments(event.data.arguments)
    return typeof parsed.value === 'string' ? parsed.value : JSON.stringify(parsed.value, null, 2)
  }
  return undefined
}
