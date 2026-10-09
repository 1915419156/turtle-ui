import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CURRENCY,
  estimateCost,
  formatBytes,
  formatCost,
  groupMcpTools,
  matchPrice,
  MCP_TOOL_PREFIX,
  type ModelPrice,
} from '../src/chat/diagnostics.ts'

const prices: ModelPrice[] = [
  { provider: 'deepseek-official', model: 'deepseek-v4-pro', input: 0.55, output: 2.19, cacheRead: 0.07 },
  { provider: '*', model: 'deepseek-v4-flash', input: 0.14, output: 0.28 },
  { input: 1, output: 3 },
]

describe('cost accounting', () => {
  it('prefers the most specific price entry for a route', () => {
    expect(matchPrice(prices, 'deepseek-official', 'deepseek-v4-pro')?.input).toBe(0.55)
    expect(matchPrice(prices, 'deepseek-official', 'deepseek-v4-flash')?.input).toBe(0.14)
    expect(matchPrice(prices, 'other', 'deepseek-v4-flash')?.input).toBe(0.14)
    // Nothing route-specific matches, so the catch-all entry wins.
    expect(matchPrice(prices, 'other', 'unknown-model')?.input).toBe(1)
  })

  it('falls back to the wildcard model when the provider is specific', () => {
    const table: ModelPrice[] = [
      { provider: 'p', model: '*', input: 9, output: 9 },
      { model: '*', input: 1, output: 1 },
    ]
    expect(matchPrice(table, 'p', 'anything')?.input).toBe(9)
    expect(matchPrice(table, 'q', 'anything')?.input).toBe(1)
  })

  it('reports no price for an empty table', () => {
    expect(matchPrice([], 'p', 'm')).toBeUndefined()
  })

  it('skips an entry that cannot price the route, rather than crashing /cost', () => {
    // The Loader schema requires `input`/`output`, but a direct caller can hand
    // `resolveTuiConfig` an unchecked value, and `undefined` used to reach
    // `formatCost` and throw. A half-configured row is skipped instead, so a
    // complete less-specific row can still match.
    const table: ModelPrice[] = [
      { model: 'm' } as unknown as ModelPrice,
      { model: '*', input: 2, output: 4 },
    ]
    expect(matchPrice(table, 'p', 'm')?.input).toBe(2)
    expect(matchPrice([{ model: '*' } as unknown as ModelPrice], 'p', 'm')).toBeUndefined()
  })

  it('sums per-million prices over token buckets', () => {
    expect(estimateCost([])).toBe(0)
    expect(estimateCost([{ tokens: 1_000_000, pricePerMillion: 2 }])).toBe(2)
    expect(estimateCost([
      { tokens: 500_000, pricePerMillion: 1 },
      { tokens: 250_000, pricePerMillion: 4 },
    ])).toBeCloseTo(1.5, 10)
  })

  it('keeps sub-cent amounts legible', () => {
    expect(formatCost(0)).toBe('$0')
    expect(formatCost(0.004321)).toBe('$0.0043')
    expect(formatCost(0.5)).toBe('$0.500')
    expect(formatCost(12.345)).toBe('$12.35')
    expect(formatCost(1, '€')).toBe('€1.00')
    expect(DEFAULT_CURRENCY).toBe('$')
  })

  it('formats byte counts with binary units', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.0 MiB')
  })
})

describe('MCP tool inventory', () => {
  it('groups names by server and keeps the raw tool names', () => {
    const groups = groupMcpTools([
      'bash',
      `${MCP_TOOL_PREFIX}files__read`,
      `${MCP_TOOL_PREFIX}files__write`,
      `${MCP_TOOL_PREFIX}git__status`,
    ])
    expect(groups).toEqual([
      { server: 'files', tools: ['read', 'write'] },
      { server: 'git', tools: ['status'] },
    ])
  })

  it('ignores non-MCP tools and tolerates a malformed name', () => {
    expect(groupMcpTools(['bash', 'read'])).toEqual([])
    // A name with no second separator still reports its server rather than
    // being dropped, so a foreign registration is visible.
    expect(groupMcpTools([`${MCP_TOOL_PREFIX}lonely`])).toEqual([{ server: 'lonely', tools: [] }])
  })

  it('keeps first-seen server order', () => {
    const groups = groupMcpTools([
      `${MCP_TOOL_PREFIX}b__one`,
      `${MCP_TOOL_PREFIX}a__two`,
      `${MCP_TOOL_PREFIX}b__three`,
    ])
    expect(groups.map(group => group.server)).toEqual(['b', 'a'])
    expect(groups[0]?.tools).toEqual(['one', 'three'])
  })
})
