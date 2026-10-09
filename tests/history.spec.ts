import { describe, expect, it } from 'vitest'
import { InputHistory, summarizeHistoryEntry, DEFAULT_HISTORY_CAPACITY } from '../src/chat/history.ts'

describe('prompt history', () => {
  it('keeps newest first, evicting the oldest beyond capacity', () => {
    const history = new InputHistory(3)
    history.add('one', 1)
    history.add('two', 2)
    history.add('three', 3)
    history.add('four', 4)
    expect(history.size).toBe(3)
    expect(history.search('').map(match => match.entry.text)).toEqual(['four', 'three', 'two'])
  })

  it('promotes a repeated prompt instead of accumulating duplicates', () => {
    const history = new InputHistory(5)
    history.add('repeat', 1)
    history.add('other', 2)
    history.add('repeat', 3)
    expect(history.size).toBe(2)
    expect(history.search('')[0]?.entry.text).toBe('repeat')
  })

  it('ignores blank submissions and honours the default capacity', () => {
    const history = new InputHistory()
    history.add('   ', 1)
    history.add('', 2)
    expect(history.size).toBe(0)
    expect(DEFAULT_HISTORY_CAPACITY).toBe(200)
    for (let index = 0; index < 250; index += 1) history.add(`prompt ${String(index)}`, index)
    expect(history.size).toBe(DEFAULT_HISTORY_CAPACITY)
  })

  it('rejects a non-positive capacity', () => {
    expect(() => new InputHistory(0)).toThrow(/positive safe integer/u)
    expect(() => new InputHistory(1.5)).toThrow(/positive safe integer/u)
  })

  it('ranks substring hits ahead of scattered fuzzy matches', () => {
    const history = new InputHistory(10)
    history.add('unrelated prose', 1)
    history.add('fix the parser', 2)
    history.add('parse', 3)
    const matches = history.search('parse').map(match => match.entry.text)
    expect(matches).toEqual(['parse', 'fix the parser'])
  })

  it('searches multi-line prompts and returns newest-first for empty queries', () => {
    const history = new InputHistory(10)
    history.add('first\nwith newline', 1)
    history.add('second', 2)
    expect(history.search('newline').map(match => match.entry.text)).toEqual(['first\nwith newline'])
    expect(history.search('   ')).toHaveLength(2)
  })

  it('honours the result limit', () => {
    const history = new InputHistory(10)
    for (let index = 0; index < 6; index += 1) history.add(`prompt ${String(index)}`, index)
    expect(history.search('prompt', 2)).toHaveLength(2)
    expect(history.search('', 3)).toHaveLength(3)
  })

  it('clears every retained entry', () => {
    const history = new InputHistory(3)
    history.add('one', 1)
    history.clear()
    expect(history.size).toBe(0)
    expect(history.search('')).toEqual([])
  })

  it('summarizes a multi-line prompt onto one clipped row', () => {
    expect(summarizeHistoryEntry('short')).toBe('short')
    expect(summarizeHistoryEntry('  spaced   out \n text ')).toBe('spaced out text')
    const long = summarizeHistoryEntry('x'.repeat(200), 20)
    expect(long).toHaveLength(20)
    expect(long.endsWith('…')).toBe(true)
  })
})
