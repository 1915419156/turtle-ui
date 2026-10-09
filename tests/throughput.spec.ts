import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  formatThroughput,
  outputCharacters,
  ThroughputTracker,
  ThroughputWindow,
  THROUGHPUT_WINDOW_MS,
} from '../src/chat/throughput.ts'

const textDelta = (text: string, index = 0): StreamChunk => ({ type: 'text-delta', index, text })
const reasoningDelta = (text: string, index = 0): StreamChunk => ({ type: 'reasoning-delta', index, text })

describe('throughput accounting', () => {
  it('sums prose characters across text and reasoning blocks only', () => {
    expect(outputCharacters([
      { type: 'text', text: 'abcd' },
      { type: 'reasoning', text: 'xy' },
      { type: 'tool-call', id: 'c1' as never, name: 'bash', arguments: '{}' },
    ])).toBe(6)
    expect(outputCharacters([])).toBe(0)
  })

  it('keeps only the window and coalesces arrivals into buckets', () => {
    const window = new ThroughputWindow()
    window.add(0, 0)
    window.add(1_000, 10)
    window.add(1_000, 5)
    window.add(1_250, 3)
    expect(window.charactersAt(1_300, 5_000)).toBe(18)
    // A window whose floor has passed the newest bucket drops the whole burst.
    // Buckets are the window's resolution, so a sub-bucket window sees nothing.
    expect(window.charactersAt(2_000, 100)).toBe(0)
    // Widening the floor to the newest bucket keeps only that bucket's arrival.
    expect(window.charactersAt(2_000, 750)).toBe(3)
    expect(window.charactersAt(2_000, 1_000)).toBe(18)
    window.clear()
    expect(window.charactersAt(2_000, 5_000)).toBe(0)
  })

  it('ignores non-positive arrivals and bounds the bucket ring', () => {
    const window = new ThroughputWindow()
    window.add(0, -5)
    expect(window.charactersAt(0, 1_000)).toBe(0)
    // A long burst stays bounded; the newest end of the window is retained.
    for (let index = 0; index < 200; index += 1) window.add(index * 1_000, 1)
    expect(window.charactersAt(199_000, THROUGHPUT_WINDOW_MS)).toBeGreaterThan(0)
  })

  it('reports no rate before anything streams', () => {
    const tracker = new ThroughputTracker()
    expect(tracker.tokensPerSecond(0)).toBeUndefined()
  })

  it('uses the fallback ratio until a step settles, then learns from it', () => {
    const tracker = new ThroughputTracker()
    // 400 characters over the window at 4 chars/token is 100 tokens over 5s: 20/s.
    tracker.feed(textDelta('a'.repeat(400)), 1_000)
    expect(tracker.tokensPerSecond(1_000)).toBeCloseTo(20, 5)

    // A settled step billing 100 output tokens for 100 characters teaches 1
    // char/token, so the same window now reads 4x higher.
    tracker.settleStep(100, 100)
    expect(tracker.tokensPerSecond(1_000)).toBeCloseTo(80, 5)
  })

  it('counts reasoning deltas and ignores block replays, block ends, and non-prose', () => {
    const tracker = new ThroughputTracker()
    tracker.feed(reasoningDelta('a'.repeat(200)), 1_000)
    const afterReasoning = tracker.tokensPerSecond(1_000)
    expect(afterReasoning).toBeCloseTo(10, 5)
    // A replayed block-end carries the same text again; it must not double-count.
    tracker.feed({ type: 'block-end', index: 0, block: { type: 'text', text: 'a'.repeat(200) } }, 1_000)
    expect(tracker.tokensPerSecond(1_000)).toBeCloseTo(10, 5)
    tracker.feed({ type: 'block-start', index: 1, blockType: 'text' }, 1_000)
    tracker.feed({ type: 'tool-call-delta', index: 2, id: 'x' as never, argumentsDelta: '{}' }, 1_000)
    expect(tracker.tokensPerSecond(1_000)).toBeCloseTo(10, 5)
  })

  it('reports the last streamed burst during quiet stretches of a turn', () => {
    const tracker = new ThroughputTracker()
    tracker.feed(textDelta('a'.repeat(400)), 1_000)
    tracker.settleStep(100, 400)
    // The live window has elapsed, but the burst itself still reports its own
    // rate rather than decaying to zero while the model thinks or calls a tool.
    expect(tracker.tokensPerSecond(100_000)).toBeCloseTo(20, 5)
    // A fresh turn clears the window: nothing measurable until it streams.
    tracker.resetWindow()
    expect(tracker.tokensPerSecond(100_000)).toBeUndefined()
  })

  it('forgets learned ratios on a full reset', () => {
    const tracker = new ThroughputTracker()
    tracker.settleStep(100, 100)
    tracker.reset()
    tracker.feed(textDelta('a'.repeat(400)), 1_000)
    expect(tracker.tokensPerSecond(1_000)).toBeCloseTo(20, 5)
  })

  it('ignores settled steps with no billable usage', () => {
    const tracker = new ThroughputTracker()
    tracker.feed(textDelta('a'.repeat(400)), 1_000)
    tracker.settleStep(0, 400)
    tracker.settleStep(100, 0)
    expect(tracker.tokensPerSecond(1_000)).toBeCloseTo(20, 5)
  })

  it('formats rates compactly', () => {
    expect(formatThroughput(0)).toBe('0.0 tok/s')
    expect(formatThroughput(42.05)).toBe('42.0 tok/s')
    expect(formatThroughput(999.9)).toBe('999.9 tok/s')
    expect(formatThroughput(1_500)).toBe('1.5k tok/s')
    expect(formatThroughput(-1)).toBe('0.0 tok/s')
  })
})
