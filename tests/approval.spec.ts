/** Approval answerer: FIFO prompt ownership, fail-closed settlement, and the dialog surface. */

import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { describe, expect, it, vi } from 'vitest'
import type { Component, Focusable } from '@earendil-works/pi-tui'
import { ApprovalDialog } from '../src/components/dialogs.ts'
import { createPalette } from '../src/components/theme.ts'
import { createApprovalQueue } from '../src/chat/approval.ts'
import { TuiOverlayManager, type TuiOverlayDriver } from '../src/extension/overlay-manager.ts'
import type { TuiOverlayOptions } from '../src/extension/types.ts'
import { resolveTuiConfig } from '../src/config.ts'
import { createTranslator } from '../src/i18n/translate.ts'

/** One modal the stub driver mounted, with the component and its close handle. */
interface MountedModal {
  component: Component & Focusable
  options: TuiOverlayOptions | undefined
  closed: boolean
  close(): void
}

/**
 * Compose the real queue over a real overlay manager and a stub driver that
 * mounts immediately and exposes the mounted component for input driving.
 */
function createFixture(options: {
  disposed?: boolean
  failShow?: boolean
  approvalMaxHeight?: () => number
} = {}) {
  const ctx = new Context()
  const mounted: MountedModal[] = []
  const closedCount = () => mounted.filter(modal => modal.closed).length
  const driver: TuiOverlayDriver = {
    viewport: () => ({ columns: 80, rows: 24 }),
    theme: () => ({
      text: value => value,
      brand: value => value,
      dim: value => value,
      accent: value => value,
      success: value => value,
      warning: value => value,
      error: value => value,
      bold: value => value,
    }),
    display: value => value,
    show: (component, showOptions) => {
      if (options.failShow === true) throw new Error('driver refused')
      const modal: MountedModal = {
        component: component as Component & Focusable,
        options: showOptions,
        closed: false,
        close() { modal.closed = true },
      }
      mounted.push(modal)
      return { hide: () => { modal.closed = true } }
    },
    invalidate: () => {},
    reportError: () => {},
  }
  const overlayManager = new TuiOverlayManager(driver)
  const session = {
    snapshotEvents: () => events,
    header: { cwd: '/workspace' },
  }
  const events: { type: string; data: { callId: string; arguments: string } }[] = []
  const agent = { ctx, session, id: SessionId('main') } as unknown as Agent
  const queue = createApprovalQueue({
    ctx,
    agent,
    resolved: resolveTuiConfig(undefined),
    palette: createPalette(false),
    overlayManager,
    translator: createTranslator('en'),
    requestRender: () => {},
    isDisposed: () => options.disposed === true,
    approvalMaxHeight: options.approvalMaxHeight ?? (() => 12),
  })
  /** Dispatch one request through the registered waterfall and return its outcome. */
  const request = (event: Partial<ApprovalRequestEvent> = {}) => agent.ctx.waterfall(
    'approval/request',
    { agent, toolName: 'bash', ...event } as ApprovalRequestEvent,
    () => Promise.resolve('unavailable'),
  )
  return { ctx, agent, queue, mounted, request, events, closedCount }
}

/** Drive the dialog the same way the terminal does, through its own key grammar. */
function press(modal: MountedModal, data: string): void {
  modal.component.handleInput?.(data)
}

describe('approval queue', () => {
  it('grants one call and closes the prompt on Allow once', async () => {
    const fixture = createFixture()
    const outcome = fixture.request({ reason: 'Writes outside the workspace' })
    await Promise.resolve()
    expect(fixture.mounted).toHaveLength(1)
    const rendered = fixture.mounted[0]!.component.render(72).join('\n')
    expect(rendered).toContain('Approval required')
    expect(rendered).toContain('bash')
    expect(rendered).toContain('Writes outside the workspace')
    expect(rendered).toContain('Allow once')
    expect(rendered).toContain('Reject')
    press(fixture.mounted[0]!, '\r')
    await expect(outcome).resolves.toBe('allowed-once')
    expect(fixture.closedCount()).toBe(1)
    fixture.queue.unregister()
  })

  it('rejects through navigation, Escape, and Ctrl+C', async () => {
    const fixture = createFixture()
    const navigated = fixture.request()
    await Promise.resolve()
    press(fixture.mounted[0]!, '\x1b[B')
    press(fixture.mounted[0]!, '\r')
    await expect(navigated).resolves.toBe('rejected')

    const escaped = fixture.request()
    await Promise.resolve()
    press(fixture.mounted[1]!, '\x1b')
    await expect(escaped).resolves.toBe('rejected')

    const interrupted = fixture.request()
    await Promise.resolve()
    press(fixture.mounted[2]!, '\x03')
    await expect(interrupted).resolves.toBe('rejected')
    fixture.queue.unregister()
  })

  it('prefers the localized display reason and previews the attached tool call', async () => {
    const fixture = createFixture({ approvalMaxHeight: () => 14 })
    fixture.agent.session.snapshotEvents = () => [
      { type: 'tool/call', data: { callId: 'call-1', arguments: '{"command":"rm -rf build"}' } },
    ] as unknown as ReturnType<Agent['session']['snapshotEvents']>
    const outcome = fixture.request({
      callId: ToolCallId('call-1'),
      reason: 'logged reason',
      displayReason: { en: 'localized reason', zh: '本地化原因' },
    })
    await Promise.resolve()
    const rendered = fixture.mounted[0]!.component.render(72).join('\n')
    expect(rendered).toContain('localized reason')
    expect(rendered).not.toContain('logged reason')
    expect(rendered).toContain('Arguments')
    expect(rendered).toContain('rm -rf build')
    press(fixture.mounted[0]!, '\x1b')
    await expect(outcome).resolves.toBe('rejected')
    fixture.queue.unregister()
  })

  it('settles a withdrawn request as cancelled and closes its prompt', async () => {
    const fixture = createFixture()
    const controller = new AbortController()
    const outcome = fixture.request({ signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    await expect(outcome).resolves.toBe('cancelled')
    expect(fixture.closedCount()).toBe(1)
    fixture.queue.unregister()
  })

  it('presents one prompt at a time and withdraws a queued request without disturbing the active one', async () => {
    const fixture = createFixture()
    const first = fixture.request({ toolName: 'first' })
    await Promise.resolve()
    const secondController = new AbortController()
    const second = fixture.request({ toolName: 'second', signal: secondController.signal })
    await Promise.resolve()
    expect(fixture.mounted).toHaveLength(1)
    secondController.abort()
    await expect(second).resolves.toBe('cancelled')
    // The active prompt keeps its slot; the queue was emptied behind it.
    expect(fixture.mounted).toHaveLength(1)
    press(fixture.mounted[0]!, '\r')
    await expect(first).resolves.toBe('allowed-once')
    fixture.queue.unregister()
  })

  it('presents the next queued request after the active one settles', async () => {
    const fixture = createFixture()
    const first = fixture.request({ toolName: 'first' })
    const second = fixture.request({ toolName: 'second' })
    await Promise.resolve()
    expect(fixture.mounted).toHaveLength(1)
    expect(fixture.mounted[0]!.component.render(72).join('\n')).toContain('first')
    press(fixture.mounted[0]!, '\r')
    await expect(first).resolves.toBe('allowed-once')
    await Promise.resolve()
    expect(fixture.mounted).toHaveLength(2)
    expect(fixture.mounted[1]!.component.render(72).join('\n')).toContain('second')
    press(fixture.mounted[1]!, '\r')
    await expect(second).resolves.toBe('allowed-once')
    fixture.queue.unregister()
  })

  it('fails closed to unavailable when the channel is disposed or the prompt cannot mount', async () => {
    const disposed = createFixture({ disposed: true })
    await expect(disposed.request()).resolves.toBe('unavailable')
    expect(disposed.mounted).toHaveLength(0)
    disposed.queue.unregister()

    const refused = createFixture({ failShow: true })
    await expect(refused.request()).resolves.toBe('unavailable')
    refused.queue.unregister()
  })

  it('settles an overlay failure as unavailable and moves on', async () => {
    // The component's own render throws (the height probe fails), which the
    // overlay manager contains by closing the session with `reason: "error"`.
    const fixture = createFixture({ approvalMaxHeight: () => { throw new Error('no rows') } })
    const outcome = fixture.request()
    await Promise.resolve()
    fixture.mounted[0]!.component.render(72)
    await expect(outcome).resolves.toBe('unavailable')
    fixture.queue.unregister()
  })

  it('withdraws every active and queued request on shutdown', async () => {
    const fixture = createFixture()
    const first = fixture.request({ toolName: 'first' })
    const second = fixture.request({ toolName: 'second' })
    await Promise.resolve()
    fixture.queue.rejectAll()
    await expect(first).resolves.toBe('cancelled')
    await expect(second).resolves.toBe('cancelled')
    expect(fixture.closedCount()).toBe(1)
    fixture.queue.unregister()
  })

  it('answers a request that was already aborted before dispatch', async () => {
    const fixture = createFixture()
    const controller = new AbortController()
    controller.abort()
    await expect(fixture.request({ signal: controller.signal })).resolves.toBe('cancelled')
    expect(fixture.mounted).toHaveLength(0)
    fixture.queue.unregister()
  })

  it('stops answering once unregistered', async () => {
    const fixture = createFixture()
    fixture.queue.unregister()
    await expect(fixture.request()).resolves.toBe('unavailable')
    expect(fixture.mounted).toHaveLength(0)
  })
})

const translator = createTranslator('en')

describe('approval dialog surface', () => {
  it('renders inside the configured panel width and row budget', () => {
    const dialog = new ApprovalDialog(
      'bash',
      'x'.repeat(400),
      '{"command":"echo hi"}',
      () => 10,
      createPalette(false),
      () => {},
      () => {},
      translator,
    )
    const lines = dialog.render(60)
    expect(lines.length).toBeLessThanOrEqual(10)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60)
    // Even under the compressed budget the decision stays on screen.
    expect(lines.join('\n')).toContain('Allow once')
  })

  it('keeps the reason while trimming an oversized argument preview', () => {
    const detail = JSON.stringify({ command: 'x'.repeat(1000) })
    const dialog = new ApprovalDialog(
      'bash',
      'Writes outside the workspace',
      detail,
      () => 16,
      createPalette(false),
      () => {},
      () => {},
      translator,
    )
    const rendered = dialog.render(72).join('\n')
    expect(rendered).toContain('Writes outside the workspace')
    expect(rendered).toContain('Arguments')
    expect(rendered).toContain('more lines')
    expect(rendered).toContain('Reject')
  })

  it('drops the argument preview before the reason under a tight budget', () => {
    const dialog = new ApprovalDialog(
      'bash',
      'Writes outside the workspace',
      '{"command":"echo hi"}',
      () => 11,
      createPalette(false),
      () => {},
      () => {},
      translator,
    )
    const rendered = dialog.render(72).join('\n')
    expect(rendered).toContain('Writes outside the workspace')
    expect(rendered).not.toContain('Arguments')
    expect(rendered).toContain('Allow once')
  })

  it('ignores unrelated keys and keeps the highlighted option selectable', () => {
    const done = vi.fn()
    const dialog = new ApprovalDialog('bash', undefined, undefined, () => 12, createPalette(false), done, () => {}, translator)
    dialog.render(40)
    dialog.handleInput('q')
    expect(done).not.toHaveBeenCalled()
    dialog.handleInput('\t')
    dialog.handleInput('\r')
    expect(done).toHaveBeenCalledWith('rejected')
  })
})
