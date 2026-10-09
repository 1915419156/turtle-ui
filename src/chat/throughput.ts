/**
 * Live output-throughput accounting for the prompt status line. A rolling
 * window over streamed assistant characters is converted to tokens with a
 * ratio learned from settled step usage, so the rate reads in the same unit the
 * provider bills while streaming — before any usage event has settled.
 * @module @deepseek-ai/dsh-tui/chat/throughput
 */

import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Fraction of a step's output tokens a streamed character is worth before any step settles. */
const DEFAULT_CHARS_PER_TOKEN = 4

/** Length of the rolling window the instantaneous rate averages over. */
export const THROUGHPUT_WINDOW_MS = 5_000

/** Bucket width the window coalesces arrivals into, bounding its ring size. */
const THROUGHPUT_BUCKET_MS = 250

/** Cap on retained buckets; a burst longer than the window still evicts oldest-first. */
const THROUGHPUT_MAX_BUCKETS = 64

/** Characters of prose (text + reasoning) in one settled assistant message. */
export function outputCharacters(content: readonly ContentBlock[]): number {
  let total = 0
  for (const block of content) {
    if (block.type === 'text' || block.type === 'reasoning') total += block.text.length
  }
  return total
}

/** Character counts streamed inside the rolling window, bucketed for a bounded ring. */
export class ThroughputWindow {
  private buckets: { stamp: number; characters: number }[] = []

  /**
   * Record `characters` streamed at `time`.
   * @param time - Stream chunk timestamp in epoch milliseconds.
   * @param characters - Non-negative streamed character count.
   */
  add(time: number, characters: number): void {
    if (characters <= 0) return
    const stamp = Math.floor(time / THROUGHPUT_BUCKET_MS) * THROUGHPUT_BUCKET_MS
    const last = this.buckets.at(-1)
    if (last !== undefined && last.stamp === stamp) {
      last.characters += characters
    } else {
      this.buckets.push({ stamp, characters })
      if (this.buckets.length > THROUGHPUT_MAX_BUCKETS) this.buckets = this.buckets.slice(-THROUGHPUT_MAX_BUCKETS)
    }
  }

  /**
   * Sum the characters whose bucket falls inside the window ending at `now`.
   * @param now - Render clock in epoch milliseconds.
   * @param windowMs - Window length in milliseconds.
   * @returns Streamed characters inside the window.
   */
  charactersAt(now: number, windowMs: number = THROUGHPUT_WINDOW_MS): number {
    const floor = now - windowMs
    let total = 0
    for (let index = this.buckets.length - 1; index >= 0; index -= 1) {
      const bucket = this.buckets[index]
      /* v8 ignore next -- the cursor stays inside the array it indexes. */
      if (bucket === undefined) continue
      if (bucket.stamp < floor) break
      total += bucket.characters
    }
    return total
  }

  /** Drop every retained bucket. */
  clear(): void {
    this.buckets = []
  }
}

/**
 * Output-rate estimator for the prompt status line. Live stream frames feed the
 * rolling window; each settled step refines the characters-to-tokens ratio so
 * the displayed rate converges on billed tokens per second.
 */
export class ThroughputTracker {
  private readonly window: ThroughputWindow
  private settledTokens = 0
  private settledCharacters = 0
  /** Clock of the most recent streamed prose chunk, anchoring the quiet-window rate. */
  private lastChunkAt: number | undefined

  constructor(window: ThroughputWindow = new ThroughputWindow()) {
    this.window = window
  }

  /** Characters per token learned from settled usage, or the fallback before any settle. */
  private get charactersPerToken(): number {
    if (this.settledTokens <= 0 || this.settledCharacters <= 0) return DEFAULT_CHARS_PER_TOKEN
    return this.settledCharacters / this.settledTokens
  }

  /**
   * Feed one live stream chunk into the rolling window.
   * @param chunk - Streamed assistant chunk.
   * @param time - The chunk's original timestamp.
   */
  feed(chunk: StreamChunk, time: number): void {
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      if (chunk.text.length > 0) this.lastChunkAt = time
      this.window.add(time, chunk.text.length)
    } else if (chunk.type === 'block-end' && (chunk.block.type === 'text' || chunk.block.type === 'reasoning')) {
      // Replayed block replacements arrive as a whole block; nothing to add —
      // the deltas already carried the characters as they streamed.
    }
  }

  /**
   * Fold one settled step's usage and answered prose into the ratio estimate.
   * @param outputTokens - Output tokens the provider billed for the step.
   * @param characters - Prose characters the step produced.
   */
  settleStep(outputTokens: number, characters: number): void {
    if (outputTokens <= 0 || characters <= 0) return
    this.settledTokens += outputTokens
    this.settledCharacters += characters
  }

  /** Rate in tokens per second over the window ending at `at`. */
  private rateAt(at: number): number | undefined {
    const characters = this.window.charactersAt(at)
    if (characters <= 0) return undefined
    return (characters / this.charactersPerToken) / (THROUGHPUT_WINDOW_MS / 1_000)
  }

  /**
   * Current output rate in tokens per second.
   * @param now - Render clock in epoch milliseconds.
   * @returns The windowed rate while characters are streaming; during the quiet
   *   stretches of a turn that has already streamed, the rate over the window
   *   ending at the last streamed chunk, so a completed burst keeps reporting
   *   its own rate instead of decaying to zero; `undefined` before this turn
   *   produced anything measurable.
   */
  tokensPerSecond(now: number): number | undefined {
    return this.rateAt(now) ?? (this.lastChunkAt === undefined ? undefined : this.rateAt(this.lastChunkAt))
  }

  /**
   * Drop the rolling window but keep the learned characters-to-tokens ratio, so
   * a new turn starts from no live rate while still reporting in learned units.
   */
  resetWindow(): void {
    this.window.clear()
    this.lastChunkAt = undefined
  }

  /** Forget the window and every learned ratio (a fresh turn or a model change). */
  reset(): void {
    this.resetWindow()
    this.settledTokens = 0
    this.settledCharacters = 0
  }
}

/**
 * Format a throughput rate for the prompt status line.
 * @param tokensPerSecond - Rate in output tokens per second.
 * @returns The compact label, e.g. `42.0 tok/s` or `1.2k tok/s`.
 */
export function formatThroughput(tokensPerSecond: number): string {
  const rate = Math.max(0, tokensPerSecond)
  if (rate < 1_000) return `${rate.toFixed(1)} tok/s`
  return `${(rate / 1_000).toFixed(1)}k tok/s`
}
