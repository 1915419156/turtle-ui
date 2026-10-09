/**
 * The transcript's two rendering modes. `rich` parses prose as Markdown;
 * `plain` renders the same text verbatim, which keeps a terminal's own
 * scrollback/search useful and avoids re-parsing long transcripts on slow or
 * narrow terminals.
 * @module @deepseek-ai/dsh-tui/components/prose
 */

import {
  Markdown,
  Text,
  type Component,
  type MarkdownOptions,
  type MarkdownTheme,
} from '@earendil-works/pi-tui'
import type { Palette } from './theme.ts'
import type { Translator } from '../i18n/translate.ts'

/** How transcript prose is presented. */
export type RenderMode = 'rich' | 'plain'

/** Whether a value names a transcript render mode. */
export function isRenderMode(value: string): value is RenderMode {
  return value === 'rich' || value === 'plain'
}

/** Default text styling for one prose block, shared by both modes. */
export interface ProseStyle {
  /** Foreground role applied to unformatted text. */
  readonly color?: ((text: string) => string) | undefined
  /** Render the block italic (reasoning prose). */
  readonly italic?: boolean | undefined
}

/**
 * Build one prose block in the active render mode. Both modes receive the same
 * already-escaped text, so switching modes changes presentation only.
 *
 * `plain` wraps the whole block in its color once rather than styling runs, so
 * a terminal drag-select copies the text without interleaved escapes; pi-tui's
 * `Text` still wraps ANSI-carrying lines to the viewport width.
 *
 * @param text - Display-escaped prose.
 * @param mode - Active transcript render mode.
 * @param mdTheme - Markdown theme for `rich`.
 * @param palette - Active role palette, used as the `plain` fallback style.
 * @param style - Per-block text styling.
 * @param options - Markdown parse options, ignored in `plain`.
 * @returns The prose component.
 */
export function proseComponent(
  text: string,
  mode: RenderMode,
  mdTheme: MarkdownTheme,
  palette: Palette,
  style: ProseStyle = {},
  options?: MarkdownOptions,
): Component {
  if (mode === 'plain') {
    const color = style.color
    // An italic block with no color still reads as reasoning prose; the
    // palette's dim tone is the one recessed role shared with `rich`.
    const styled = color === undefined
      ? style.italic === true ? palette.dim(text) : text
      : color(text)
    return new Text(styled, 0, 0)
  }
  const defaultTextStyle = {
    ...style.color === undefined ? {} : { color: style.color },
    ...style.italic === true ? { italic: true } : {},
  }
  return new Markdown(text, 0, 0, mdTheme, defaultTextStyle, options)
}

/**
 * The one-word label a render-mode change reports, so `/render`, the config
 * value, and any future toggle all describe the mode identically.
 * @param mode - Active render mode.
 * @param t - Translator supplying the label.
 * @returns The display label.
 */
export function renderModeLabel(mode: RenderMode, t: Translator['t']): string {
  return t(mode === 'rich' ? 'renderMode.rich' : 'renderMode.plain')
}
