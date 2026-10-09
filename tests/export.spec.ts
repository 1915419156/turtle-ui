import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createUserMessage, createMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_MARKDOWN_TOOL_CHARACTERS,
  defaultExportName,
  exportSession,
  isExportFormat,
  renderJsonlTranscript,
  renderMarkdownTranscript,
  resolveExportPath,
} from '../src/chat/export.ts'
import { appendAssistant, appendUser, createTuiTestHarness } from './harness.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

const event = <T extends SessionEvent>(value: T): SessionEvent => value

function sampleEvents(): SessionEvent[] {
  return [
    event({ type: 'turn/start', seq: SessionSeq(0), time: 1_000, data: { turn: 1 } }),
    event({
      type: 'user/message',
      seq: SessionSeq(1),
      time: 1_001,
      data: createUserMessage({ content: [{ type: 'text', text: 'do the thing' }], source: { kind: 'user' } }),
      surfaceOp: 'append',
    }),
    event({
      type: 'user/message',
      seq: SessionSeq(2),
      time: 1_002,
      data: createUserMessage({
        content: [{ type: 'text', text: 'injected instructions' }],
        source: { kind: 'plugin', plugin: 'workspace-context' } as never,
      }),
      surfaceOp: 'append',
    }),
    event({
      type: 'assistant/message',
      seq: SessionSeq(3),
      time: 1_003,
      data: {
        turn: 1,
        step: 1,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'weighing options' },
            { type: 'text', text: 'here is the answer' },
          ],
          source: { kind: 'model', provider: 'mock', model: 'm' },
        }),
        stream: [],
      },
      surfaceOp: 'append',
    }),
    event({ type: 'tool/call', seq: SessionSeq(4), time: 1_004, data: { turn: 1, step: 1, callId: 'c1' as never, name: 'bash', arguments: '{"command":"ls"}' } }),
    event({
      type: 'tool/result',
      seq: SessionSeq(5),
      time: 1_005,
      data: {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: 'c1' as never,
          content: [{ type: 'text', text: 'file-a\nfile-b' }],
          isError: false,
        }),
      },
      surfaceOp: 'append',
    }),
    event({
      type: 'session/title',
      seq: SessionSeq(6),
      time: 1_006,
      data: { title: 'A titled session', messageSeqs: [], source: { kind: 'user' } },
    }),
    event({ type: 'compaction/end', seq: SessionSeq(7), time: 1_007, data: { compactionId: 'k' as never, turn: null } } as SessionEvent),
    event({ type: 'turn/end', seq: SessionSeq(8), time: 1_008, data: { turn: 1, reason: { kind: 'completed' } } }),
  ]
}

describe('session export', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'dsh-tui-export-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('recognizes only the two supported formats', () => {
    expect(isExportFormat('md')).toBe(true)
    expect(isExportFormat('jsonl')).toBe(true)
    expect(isExportFormat('json')).toBe(false)
    expect(isExportFormat('txt')).toBe(false)
  })

  it('names the default file with a timestamp and the session id', () => {
    const name = defaultExportName({ id: SessionId('my/session id') } as never, 'md', new Date(2026, 0, 2, 3, 4, 5).getTime())
    expect(name).toBe('dsh-20260102-030405-my-session-id.md')
    expect(defaultExportName({ id: SessionId('x') } as never, 'jsonl', 0).endsWith('.jsonl')).toBe(true)
  })

  it('resolves a relative path against the workspace and keeps absolute paths', () => {
    expect(resolveExportPath(undefined, '/ws', 'fallback.md')).toBe(resolve('/ws', 'fallback.md'))
    expect(resolveExportPath('   ', '/ws', 'fallback.md')).toBe(resolve('/ws', 'fallback.md'))
    expect(resolveExportPath('out.md', '/ws', 'fallback.md')).toBe(resolve('/ws', 'out.md'))
    expect(resolveExportPath('/tmp/out.md', '/ws', 'fallback.md')).toBe('/tmp/out.md')
    // A trailing slash means "a directory": the fallback name fills it in.
    expect(resolveExportPath('logs/', '/ws', 'fallback.md')).toBe(resolve('/ws/logs', 'fallback.md'))
  })

  it('renders a Markdown transcript with roles, reasoning, tools, and the title', () => {
    const markdown = renderMarkdownTranscript(sampleEvents())
    expect(markdown.startsWith('# Session transcript')).toBe(true)
    expect(markdown).toContain('> A titled session')
    expect(markdown).toContain('## You\n\ndo the thing')
    expect(markdown).toContain('> **Context (plugin)**')
    expect(markdown).toContain('<summary>Reasoning</summary>')
    expect(markdown).toContain('## Assistant\n\nhere is the answer')
    expect(markdown).toContain('### Tool: bash (ok)')
    expect(markdown).toContain('file-a\nfile-b')
    expect(markdown).toContain('> _Context compacted_')
    // A completed turn adds no noise line.
    expect(markdown).not.toContain('Turn ended')
  })

  it('clips long tool output in the Markdown transcript', () => {
    const events: SessionEvent[] = [
      event({ type: 'tool/call', seq: SessionSeq(0), time: 1, data: { turn: 1, step: 1, callId: 'c1' as never, name: 'bash', arguments: '{}' } }),
      event({
        type: 'tool/result',
        seq: SessionSeq(1),
        time: 2,
        data: {
          turn: 1, step: 1,
          message: createToolResultMessage({
            callId: 'c1' as never,
            content: [{ type: 'text', text: 'x'.repeat(20) }],
            isError: false,
          }),
        },
        surfaceOp: 'append',
      }),
    ]
    const clipped = renderMarkdownTranscript(events, 5)
    expect(clipped).toContain('… [15 more characters]')
    expect(renderMarkdownTranscript(events, DEFAULT_MARKDOWN_TOOL_CHARACTERS)).toContain('x'.repeat(20))
  })

  it('reports a non-completed turn reason and a missing tool call', () => {
    const events: SessionEvent[] = [
      event({
        type: 'tool/result',
        seq: SessionSeq(0),
        time: 1,
        data: {
          turn: 1, step: 1,
          message: createToolResultMessage({
            callId: 'orphan' as never,
            content: [{ type: 'text', text: 'a failure' }],
            isError: true,
          }),
        },
        surfaceOp: 'append',
      }),
      event({ type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } }),
    ]
    const markdown = renderMarkdownTranscript(events)
    expect(markdown).toContain('### Tool: tool (error)')
    expect(markdown).toContain('> _Turn ended: aborted_')
  })

  it('serializes JSONL with type, time, data, and seq', () => {
    const lines = renderJsonlTranscript(sampleEvents()).trimEnd().split('\n')
    expect(lines).toHaveLength(9)
    const first = JSON.parse(lines[0] ?? '{}') as { type: string; seq: number }
    expect(first.type).toBe('turn/start')
    expect(first.seq).toBe(0)
  })

  it('writes both formats and reports what landed', async () => {
    const terminal = new HeadlessTerminal(80, 24)
    const harness = await createTuiTestHarness(terminal, () => {})
    try {
      appendUser(harness.session, 'export me')
      appendAssistant(harness.session, [{ type: 'text', text: 'exported' }])

      const markdownPath = join(directory, 'nested', 'session.md')
      const markdown = await exportSession(harness.session, 'md', markdownPath)
      expect(markdown.path).toBe(markdownPath)
      expect(markdown.events).toBeGreaterThan(0)
      expect(markdown.bytes).toBeGreaterThan(0)

      const jsonl = await exportSession(harness.session, 'jsonl', join(directory, 'session.jsonl'))
      expect(jsonl.events).toBe(markdown.events)
      expect(jsonl.bytes).toBeGreaterThan(0)
    } finally {
      await harness.controller.dispose()
      await harness.ctx.fiber.dispose()
      await terminal.dispose()
    }
  })
})
