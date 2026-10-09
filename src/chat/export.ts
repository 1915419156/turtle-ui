/**
 * Session export: serialize the live session log to a self-contained file on
 * disk, in a lossless JSONL form or a human-readable Markdown transcript.
 *
 * The JSONL form is the durable log's own shape — one event per line — so it
 * round-trips and can be diffed; the Markdown form is a reading transcript and
 * deliberately drops nothing of what a human wrote, but folds reasoning and
 * abbreviates tool output.
 * @module @deepseek-ai/dsh-tui/chat/export
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { contentText } from '../components/content.ts'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createTranslator, type Translator } from '../i18n/translate.ts'

/** Output format of one session export. */
export type ExportFormat = 'md' | 'jsonl'

/** Whether a value names an export format. */
export function isExportFormat(value: string): value is ExportFormat {
  return value === 'md' || value === 'jsonl'
}

/** Default maximum tool-result characters a Markdown export keeps per call. */
export const DEFAULT_MARKDOWN_TOOL_CHARACTERS = 2_000

/** What one export request produced. */
export interface ExportResult {
  /** Absolute path written. */
  readonly path: string
  /** Bytes written. */
  readonly bytes: number
  /** Events serialized. */
  readonly events: number
}

/**
 * Default export file name for a session: `dsh-<date>-<time>-<session>.md`
 * with a filesystem-safe session id.
 * @param session - Session being exported.
 * @param format - Output format, selecting the extension.
 * @param at - Export time in epoch milliseconds.
 * @returns A relative file name.
 */
export function defaultExportName(session: Session, format: ExportFormat, at: number = Date.now()): string {
  const date = new Date(at)
  const stamp = [
    date.getFullYear().toString().padStart(4, '0'),
    (date.getMonth() + 1).toString().padStart(2, '0'),
    date.getDate().toString().padStart(2, '0'),
  ].join('')
  const clock = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(value => value.toString().padStart(2, '0'))
    .join('')
  const safeId = String(session.id).replace(/[^A-Za-z0-9._-]/gu, '-')
  return `dsh-${stamp}-${clock}-${safeId}.${format}`
}

/**
 * Resolve the destination path for an export. A relative `target` resolves
 * against the session workspace, so `/export` needs no absolute path.
 * @param target - Requested path, absolute or workspace-relative; `undefined` uses `fallbackName`.
 * @param cwd - Session working directory.
 * @param fallbackName - File name used when `target` is absent.
 * @returns The absolute destination path.
 */
export function resolveExportPath(target: string | undefined, cwd: string, fallbackName: string): string {
  if (target === undefined || target.trim() === '') return resolve(cwd, fallbackName)
  const trimmed = target.trim()
  if (trimmed.endsWith('/') || trimmed.endsWith('\\')) return resolve(cwd, trimmed, fallbackName)
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed)
}

/** One text block of a message, concatenated in block order. */
function messageText(content: readonly ContentBlock[]): string {
  return contentText(content).trim()
}

/** Render a tool result's text, clipped to the Markdown budget. */
function summarizeToolResult(message: Message, limit: number, t: Translator['t']): string {
  const text = messageText(message.content).trim()
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}${t('export.clipped', { count: text.length - limit })}`
}

/**
 * Render the session as a Markdown transcript: one section per turn, reasoning
 * folded into a collapsible block, tool calls as fenced details.
 * @param events - Session events in log order.
 * @param toolCharacters - Maximum characters kept per tool result.
 * @param translator - Locale for the transcript's headings and labels.
 * @returns The complete Markdown document.
 */
export function renderMarkdownTranscript(
  events: readonly SessionEvent[],
  toolCharacters: number = DEFAULT_MARKDOWN_TOOL_CHARACTERS,
  translator: Translator = createTranslator('en'),
): string {
  const { t } = translator
  const lines: string[] = [t('export.title'), '']
  const pendingCalls = new Map<string, { name: string; arguments: string }>()
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        const source = event.data.source
        const text = messageText(event.data.content)
        if (text === '') break
        // Injected context is marked as such rather than presented as a prompt.
        if (source.kind !== 'user') {
          lines.push(t('export.context', { kind: source.kind }), '', text, '')
          break
        }
        lines.push(t('export.you'), '', text, '')
        break
      }
      case 'assistant/message': {
        const reasoning = event.data.message.content
          .filter(block => block.type === 'reasoning')
          .map(block => block.text)
          .join('\n\n')
          .trim()
        const text = event.data.message.content
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('\n\n')
          .trim()
        if (reasoning !== '') {
          lines.push(t('export.reasoningSummary'), '', reasoning, '', '</details>', '')
        }
        if (text !== '') lines.push(t('export.assistant'), '', text, '')
        break
      }
      case 'tool/call':
        pendingCalls.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments })
        break
      case 'tool/result': {
        const callId = event.data.message.toolCallId
        const call = pendingCalls.get(callId)
        pendingCalls.delete(callId)
        const name = call?.name ?? t('export.toolFallbackName')
        const status = t(event.data.message.isError === true
          ? 'export.toolStatusError'
          : 'export.toolStatusOk')
        lines.push(t('export.toolHeading', { name, status }), '')
        if (call !== undefined && call.arguments.trim() !== '') {
          lines.push('```json', call.arguments.trim(), '```', '')
        }
        const text = summarizeToolResult(event.data.message, toolCharacters, t)
        if (text !== '') lines.push('```', text, '```', '')
        break
      }
      case 'session/title':
        lines.splice(1, 0, `> ${event.data.title}`, '')
        break
      case 'turn/end': {
        const reason = event.data.reason
        if (reason.kind !== 'completed') lines.push(t('export.turnEnded', { kind: reason.kind }), '')
        break
      }
      case 'compaction/end':
        lines.push(t('export.compacted'), '')
        break
      default:
        break
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`
}

/**
 * Render the session's events as newline-delimited JSON, one event per line,
 * preserving the durable log's own field order.
 * @param events - Session events in log order.
 * @returns The complete JSONL document.
 */
export function renderJsonlTranscript(events: readonly SessionEvent[]): string {
  return events.map(event => JSON.stringify({
    type: event.type,
    time: event.time,
    data: event.data,
    ...'seq' in event ? { seq: event.seq } : {},
  })).join('\n') + '\n'
}

/**
 * Write one session export.
 * @param session - Live session whose log is written.
 * @param format - Output format.
 * @param path - Absolute destination path.
 * @param toolCharacters - Markdown tool-result budget.
 * @returns What was written, including the byte count.
 * @throws when the directory cannot be created or the write fails.
 */
export async function exportSession(
  session: Session,
  format: ExportFormat,
  path: string,
  toolCharacters: number = DEFAULT_MARKDOWN_TOOL_CHARACTERS,
  translator: Translator = createTranslator('en'),
): Promise<ExportResult> {
  const events = session.snapshotEvents()
  const body = format === 'jsonl'
    ? renderJsonlTranscript(events)
    : renderMarkdownTranscript(events, toolCharacters, translator)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, 'utf8')
  return {
    path,
    bytes: Buffer.byteLength(body, 'utf8'),
    events: events.length,
  }
}
