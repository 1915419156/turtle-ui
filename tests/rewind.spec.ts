import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type SessionEvent, type Session } from '@deepseek-ai/dsh-session'
import { deriveRestorePoints, findRestorePoint } from '../src/chat/rewind.ts'

/** Minimal Session stand-in: only `snapshotEvents` is read by the derivation. */
function sessionOf(events: readonly SessionEvent[]): Session {
  return { snapshotEvents: () => events, id: SessionId('s') } as unknown as Session
}

const prompt = (seq: number, text: string): SessionEvent => ({
  type: 'user/message',
  seq: SessionSeq(seq),
  time: seq,
  data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
  surfaceOp: 'append',
})

const turn = (n: number, startSeq: number, endSeq: number): SessionEvent[] => [
  { type: 'turn/start', seq: SessionSeq(startSeq), time: startSeq, data: { turn: n } },
  prompt(startSeq + 1, `prompt ${String(n)}`),
  { type: 'turn/end', seq: SessionSeq(endSeq), time: endSeq, data: { turn: n, reason: { kind: 'completed' } } },
]

describe('restore points', () => {
  it('returns nothing for an empty log', () => {
    expect(deriveRestorePoints(sessionOf([]))).toEqual([])
  })

  it('offers one point per completed turn plus a head, newest first, deduped', () => {
    const events = [...turn(1, 0, 3), ...turn(2, 4, 7)]
    const points = deriveRestorePoints(sessionOf(events))
    expect(points).toHaveLength(2)
    // The newest completed turn ends at the log head, so one row serves both
    // the head and that turn's rewind point.
    expect(points[0]?.boundary).toBe(7)
    expect(points[0]?.head).toBe(true)
    expect(points[0]?.label).toContain('Turn 2')
    expect(points[1]?.boundary).toBe(3)
    expect(points[1]?.head).toBe(false)
    expect(points[1]?.label).toContain('prompt 1')
  })

  it('adds a distinct head row when the log grew past the last turn', () => {
    const events: SessionEvent[] = [
      ...turn(1, 0, 3),
      { type: 'turn/start', seq: SessionSeq(4), time: 4, data: { turn: 2 } },
      prompt(5, 'in progress'),
    ]
    const points = deriveRestorePoints(sessionOf(events))
    expect(points[0]?.head).toBe(true)
    expect(points[0]?.boundary).toBe(5)
    expect(points[0]?.label).toContain('branch here')
    expect(points[1]?.boundary).toBe(3)
    expect(points[1]?.head).toBe(false)
  })

  it('labels a turn whose prompt is absent, and clips a long prompt', () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: SessionSeq(2), time: 2, data: { turn: 2 } },
      prompt(3, 'y'.repeat(200)),
      { type: 'turn/end', seq: SessionSeq(4), time: 4, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const points = deriveRestorePoints(sessionOf(events))
    expect(points.find(point => point.boundary === 1)?.label).toBe('Turn 1')
    const clipped = points.find(point => point.boundary === 4)?.label ?? ''
    expect(clipped).toContain('…')
    expect(clipped.length).toBeLessThan(70)
  })

  it('ignores a turn-scoped prompt that never lands, and empty prompts', () => {
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
      prompt(1, '   '),
      { type: 'turn/end', seq: SessionSeq(2), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const points = deriveRestorePoints(sessionOf(events))
    expect(points[0]?.label).toBe('Turn 1 · (empty prompt)')
  })

  it('finds a point by its boundary', () => {
    const points = deriveRestorePoints(sessionOf(turn(1, 0, 3)))
    expect(findRestorePoint(points, 3)?.boundary).toBe(3)
    expect(findRestorePoint(points, 99)).toBeUndefined()
  })

  it('does not invent a turn number for a boundary that has no turn/start', () => {
    // A truncated or foreign log can open mid-turn; `Turn 0` would name a turn
    // the session never had, so the row is named by its prompt instead.
    const events: SessionEvent[] = [
      prompt(0, 'orphaned prompt'),
      { type: 'turn/end', seq: SessionSeq(1), time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
      ...turn(2, 2, 5),
    ]
    const points = deriveRestorePoints(sessionOf(events))
    const orphaned = points.find(point => point.boundary === 1)
    expect(orphaned?.label).toBe('Earlier log · orphaned prompt')
    // A later, properly opened turn still reports its own number.
    expect(points.find(point => point.boundary === 5)?.label).toContain('Turn 2')
  })

  it('describes what each point keeps', () => {
    const events = [...turn(1, 0, 3), ...turn(2, 4, 7)]
    const points = deriveRestorePoints(sessionOf(events))
    expect(points[0]?.detail).toContain('fork without rewinding')
    expect(points[1]?.detail).toContain('rewind here')
  })
})
