/**
 * Restore-point derivation for the rewind/fork picker. A restore point is a
 * boundary in the session log the user can fork from: the end of a completed
 * turn (rewinding past the turns after it) or the current log end (branching
 * without rewinding).
 * @module @deepseek-ai/dsh-tui/chat/rewind
 */

import { contentText } from '../components/content.ts'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createTranslator, type Translator } from '../i18n/translate.ts'

/** One selectable fork boundary in the session log. */
export interface RestorePoint {
  /** Inclusive event sequence the fork inherits through; `-1` means an empty fork. */
  readonly boundary: number
  /** Short label naming the turn this point sits after. */
  readonly label: string
  /**
   * The label split into its two display halves: a narrow name the picker's
   * primary column shows, and the turn's prompt, which goes in the description.
   * A list row reserves a fixed-width primary column, so a long label there
   * would push the description out of the row instead of wrapping.
   */
  readonly short: string
  /** First human prompt of the turn, clipped; `undefined` when the turn had none. */
  readonly prompt: string | undefined
  /** Secondary line: what the fork would keep. */
  readonly detail: string
  /** Whether this is the current log end (a branch, not a rewind). */
  readonly head: boolean
}

/** `N event` / `N events` as the restore-point detail line writes it. */
function eventCount(count: number, t: Translator['t']): string {
  return t(count === 1 ? 'rewind.eventOne' : 'rewind.eventMany', { count })
}

/** Collapse a prompt to one short display line. */
function promptLabel(text: string, t: Translator['t'], maxLength = 48): string {
  const flat = contentText([{ type: 'text', text }]).replace(/\s+/gu, ' ').trim()
  if (flat === '') return t('rewind.emptyPrompt')
  return flat.length <= maxLength ? flat : `${flat.slice(0, Math.max(0, maxLength - 1))}…`
}

/** The first human prompt of one turn, used to title its restore point. */
function turnPrompt(
  events: readonly SessionEvent[],
  from: number,
  to: number,
  t: Translator['t'],
): string | undefined {
  for (let index = from; index < to; index += 1) {
    const event = events[index]
    /* v8 ignore next -- the cursor stays inside the array it indexes. */
    if (event === undefined) continue
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      return promptLabel(contentText(event.data.content), t)
    }
  }
  return undefined
}

/**
 * Derive the session's restore points, newest first.
 *
 * A point is the last event of each completed turn plus the current log end.
 * The newest point is the head: forking there branches the conversation without
 * discarding anything, while any older point rewinds the turns after it.
 *
 * @param session - Live session whose log defines the boundaries.
 * @param translator - Locale for the row labels the picker shows.
 * @returns Restore points newest first; empty for an empty log.
 */
export function deriveRestorePoints(
  session: Session,
  translator: Translator = createTranslator('en'),
): RestorePoint[] {
  const { t } = translator
  const events = session.snapshotEvents()
  if (events.length === 0) return []
  // Collected oldest-first because the scan is a forward pass; reversed before
  // returning so the array reads newest-first for the picker.
  const turns: RestorePoint[] = []
  let turnStart = 0
  let turnNumber: number | undefined
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    /* v8 ignore next -- the cursor stays inside the array it indexes. */
    if (event === undefined) continue
    if (event.type === 'turn/start') {
      turnStart = index
      turnNumber = event.data.turn
      continue
    }
    if (event.type !== 'turn/end') continue
    const prompt = turnPrompt(events, turnStart, index, t)
    // A log that starts mid-turn (a truncated or foreign one) has no
    // `turn/start` to name this boundary, and `Turn 0` would be a turn number
    // the session never had. Name the row by its prompt, or say where it is.
    const short = turnNumber === undefined ? t('rewind.earlierLog') : t('rewind.turn', { number: turnNumber })
    turns.push({
      boundary: event.seq,
      label: `${short}${prompt === undefined ? '' : ` · ${prompt}`}`,
      short,
      prompt,
      detail: t('rewind.rewindHere', { events: eventCount(event.seq + 1, t) }),
      head: false,
    })
    turnNumber = undefined
  }
  const last = events.at(-1)
  /* v8 ignore next -- a non-empty array always has a last element. */
  if (last === undefined) return turns.reverse()
  const newestTurn = turns.at(-1)
  if (newestTurn !== undefined && newestTurn.boundary === last.seq) {
    // The newest completed turn already ends at the log head, so one row serves
    // both meanings: forking here branches rather than discards.
    turns[turns.length - 1] = {
      ...newestTurn,
      head: true,
      detail: t('rewind.forkHere', { events: eventCount(last.seq + 1, t) }),
    }
  } else {
    turns.push({
      boundary: last.seq,
      label: t('rewind.currentEnd'),
      short: t('rewind.currentEndPlain'),
      prompt: undefined,
      detail: t('rewind.forkHere', { events: eventCount(events.length, t) }),
      head: true,
    })
  }
  return turns.reverse()
}

/**
 * Find the restore point at one boundary.
 * @param points - Restore points from {@link deriveRestorePoints}.
 * @param boundary - Selected boundary.
 * @returns The matching point, or `undefined` when the boundary is not a point.
 */
export function findRestorePoint(
  points: readonly RestorePoint[],
  boundary: number,
): RestorePoint | undefined {
  return points.find(point => point.boundary === boundary)
}
