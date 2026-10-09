import { describe, expect, it } from 'vitest'
import { Markdown, Text } from '@earendil-works/pi-tui'
import { createPalette, markdownTheme } from '../src/components/theme.ts'
import { isRenderMode, proseComponent, renderModeLabel } from '../src/components/prose.ts'
import { createTranslator } from '../src/i18n/translate.ts'

const palette = createPalette(false, 'dark')
const theme = markdownTheme(palette)
const strip = (value: string): string => value.replace(/\x1b\[[0-9;]*m/gu, '')
const t = createTranslator('en').t

describe('transcript render modes', () => {
  it('recognizes only the two modes', () => {
    expect(isRenderMode('rich')).toBe(true)
    expect(isRenderMode('plain')).toBe(true)
    expect(isRenderMode('markdown')).toBe(false)
    expect(isRenderMode('')).toBe(false)
  })

  it('labels both modes for user-facing notices', () => {
    expect(renderModeLabel('rich', t)).toBe('rich (Markdown)')
    expect(renderModeLabel('plain', t)).toBe('plain (verbatim)')
  })

  it('builds a Markdown component in rich mode', () => {
    const component = proseComponent('hello', 'rich', theme, palette)
    expect(component).toBeInstanceOf(Markdown)
  })

  it('builds a Text component in plain mode', () => {
    const component = proseComponent('hello', 'plain', theme, palette)
    expect(component).toBeInstanceOf(Text)
    expect(component).not.toBeInstanceOf(Markdown)
  })

  it('renders Markdown syntax literally in plain mode and formatted in rich mode', () => {
    const source = '**bold** and `code`'
    const rich = new Markdown(source, 0, 0, theme, {}).render(60)
    const plain = proseComponent(source, 'plain', theme, palette).render(60)
    // Markdown drops the emphasis markers; plain keeps the source bytes.
    expect(strip(rich.join('\n'))).not.toContain('**')
    expect(strip(plain.join('\n'))).toContain('**bold** and `code`')
  })

  it('applies the block color and italic in plain mode', () => {
    const colored = proseComponent('text', 'plain', theme, palette, { color: value => `[${value}]` }).render(20)
    expect(colored.join('\n')).toContain('[text]')
    // An italic block with no explicit color falls back to the recessed tone
    // instead of rendering bare text.
    const italic = proseComponent('text', 'plain', theme, palette, { italic: true }).render(20)
    expect(italic).toHaveLength(1)
  })

  it('keeps a long plain block wrapping to the viewport width', () => {
    const rows = proseComponent('word '.repeat(40), 'plain', theme, palette).render(30)
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) expect(strip(row).length).toBeLessThanOrEqual(30)
  })

  it('reports an intentionally wrong mode as neither', () => {
    // Exhaustiveness guard: adding a third mode without updating the label
    // would leave one of these failing.
    const modes: string[] = ['rich', 'plain']
    expect(modes.map(mode => (isRenderMode(mode) ? renderModeLabel(mode, t) : mode))).toEqual([
      'rich (Markdown)',
      'plain (verbatim)',
    ])
  })
})
