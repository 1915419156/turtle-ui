/**
 * Bounded prompt history for the editor's search panel. pi-tui's {@link Editor}
 * keeps its own arrow-key history, but it is private and unbounded, so the
 * searchable list is maintained here as a bounded mirror fed from the same
 * submission points.
 * @module @deepseek-ai/dsh-tui/chat/history
 */

import { fuzzyMatch } from '@earendil-works/pi-tui'

/** Default retained prompt entries. Older submissions are dropped, never rotated. */
export const DEFAULT_HISTORY_CAPACITY = 200

/** One retained prompt submission. */
export interface HistoryEntry {
  /** Submitted prompt text, verbatim. */
  readonly text: string
  /** Submission time in epoch milliseconds. */
  readonly at: number
}

/** One ranked history search result. */
export interface HistoryMatch {
  /** The matching entry. */
  readonly entry: HistoryEntry
  /** Match quality; lower is better. */
  readonly score: number
}

/**
 * Fixed-capacity prompt history with fuzzy search. Duplicate submissions move
 * the existing entry to the front instead of accumulating, so repeated `continue`
 * prompts do not crowd out distinct history.
 */
export class InputHistory {
  private entries: HistoryEntry[] = []

  constructor(private readonly capacity: number = DEFAULT_HISTORY_CAPACITY) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error('history capacity must be a positive safe integer')
    }
  }

  /**
   * Record one submission, newest first, evicting the oldest beyond capacity.
   * @param text - Submitted prompt text; blank input is ignored.
   * @param at - Submission time in epoch milliseconds.
   */
  add(text: string, at: number = Date.now()): void {
    const trimmed = text.trim()
    if (trimmed === '') return
    const existing = this.entries.findIndex(entry => entry.text === text)
    if (existing >= 0) this.entries.splice(existing, 1)
    this.entries.unshift({ text, at })
    if (this.entries.length > this.capacity) this.entries.length = this.capacity
  }

  /**
   * Rank entries against a query. An empty query returns the newest entries in
   * submission order; otherwise an entry ranks by fuzzy score with exact
   * substring hits preferred.
   * @param query - Search text.
   * @param limit - Maximum results returned.
   * @returns Ranked matches, newest-first among equals.
   */
  search(query: string, limit = this.capacity): HistoryMatch[] {
    const needle = query.trim()
    if (needle === '') {
      return this.entries.slice(0, limit).map(entry => ({ entry, score: 0 }))
    }
    const matches: HistoryMatch[] = []
    for (const entry of this.entries) {
      const fuzzy = fuzzyMatch(needle, entry.text)
      if (!fuzzy.matches) continue
      const substring = entry.text.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
      matches.push({ entry, score: fuzzy.score - (substring ? 100 : 0) })
    }
    matches.sort((left, right) =>
      left.score - right.score
      || right.entry.at - left.entry.at)
    return matches.slice(0, limit)
  }

  /** Number of retained entries. */
  get size(): number {
    return this.entries.length
  }

  /** Drop every retained entry. */
  clear(): void {
    this.entries = []
  }
}

/**
 * Collapse a prompt to a single display row for the search list.
 * @param text - Prompt text, possibly multi-line.
 * @returns One line with whitespace runs flattened and long text elided.
 */
export function summarizeHistoryEntry(text: string, maxLength = 72): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat.length <= maxLength) return flat
  return `${flat.slice(0, Math.max(0, maxLength - 1))}…`
}
