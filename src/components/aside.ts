/**
 * Transcript card for one `/btw` side question. The answer streams in place:
 * each chunk re-renders the card, so a side question reads like any other
 * streamed answer without ever entering the session log.
 * @module @deepseek-ai/dsh-tui/components/aside
 */

import { Container, Text, type MarkdownTheme } from '@earendil-works/pi-tui'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { displayText } from './text.ts'
import { proseComponent, type RenderMode } from './prose.ts'
import type { Palette } from './theme.ts'
import type { Translator } from '../i18n/translate.ts'

/**
 * The transcript label a side question's answer carries, naming the question it
 * answers so a reader can tell it apart from the conversation.
 * @param question - The side question.
 * @param t - Translator supplying the label frame.
 * @returns The card's header label.
 */
export function sideQuestionLabel(question: string, t: Translator['t']): string {
  const flat = question.replace(/\s+/gu, ' ').trim()
  const clipped = flat.length <= 56 ? flat : `${flat.slice(0, 55)}…`
  return t('aside.header', { question: clipped })
}

/**
 * Streaming card for a side question's answer. The card owns the accumulated
 * answer text; the caller feeds it stream chunks and reports the settled
 * outcome, so a failure replaces the partial answer rather than leaving it
 * looking final.
 */
export class AsideAnswerComponent extends Container {
  private text = ''
  private reasoning = ''
  private failed: string | undefined
  private settled = false

  constructor(
    private readonly question: string,
    private showReasoning: boolean,
    private renderMode: RenderMode,
    private readonly palette: Palette,
    private readonly mdTheme: MarkdownTheme,
    private readonly translator: Translator,
  ) {
    super()
    this.rebuild()
  }

  /**
   * Fold one streamed chunk into the accumulated answer and re-render.
   * @param chunk - The streamed assistant chunk.
   */
  update(chunk: StreamChunk): void {
    if (chunk.type === 'text-delta') this.text += chunk.text
    else if (chunk.type === 'reasoning-delta') this.reasoning += chunk.text
    else if (chunk.type === 'block-end') {
      // A settled block replaces whatever the deltas accumulated for its index,
      // so it is authoritative for that block; deltas for later blocks still
      // accumulate after it.
      if (chunk.block.type === 'text' && chunk.block.text !== '') this.text = chunk.block.text
      else if (chunk.block.type === 'reasoning' && chunk.block.text !== '') this.reasoning = chunk.block.text
    }
    this.rebuild()
  }

  /**
   * Settle the card with the final answer, or with the failure that replaced it.
   * @param answer - The assembled answer text and reasoning.
   * @param error - Failure message when the run failed instead of answering.
   */
  settle(answer: { text: string; reasoning: string } | undefined, error: string | undefined): void {
    if (answer !== undefined) {
      this.text = answer.text
      this.reasoning = answer.reasoning
    }
    this.failed = error
    this.settled = true
    this.rebuild()
  }

  /** Whether this card has received its settled outcome. */
  isSettled(): boolean {
    return this.settled
  }

  /**
   * Toggle reasoning display for this card.
   * @param show - Whether reasoning prose renders.
   */
  setShowReasoning(show: boolean): void {
    this.showReasoning = show
    this.rebuild()
  }

  /**
   * Switch this card's render mode.
   * @param mode - Active transcript render mode.
   */
  setRenderMode(mode: RenderMode): void {
    this.renderMode = mode
    this.rebuild()
  }

  private rebuild(): void {
    this.clear()
    const { t } = this.translator
    this.addChild(new Text(
      this.palette.bold(this.palette.underline(this.palette.accent(displayText(sideQuestionLabel(this.question, t))))),
      0,
      0,
    ))
    if (this.failed !== undefined) {
      this.addChild(new Text(this.palette.error(displayText(t('aside.failed', { error: this.failed }))), 0, 0))
      return
    }
    const reasoning = displayText(this.reasoning.trim())
    if (this.showReasoning && reasoning !== '') {
      this.addChild(new Text(this.palette.italic(this.palette.dim(t('label.reasoning'))), 0, 0))
      this.addChild(proseComponent(reasoning, this.renderMode, this.mdTheme, this.palette, {
        color: value => this.palette.dim(value),
        italic: true,
      }))
    }
    const text = displayText(this.text.trim())
    if (text !== '') {
      this.addChild(proseComponent(text, this.renderMode, this.mdTheme, this.palette, {
        color: value => this.palette.text(value),
      }))
    } else if (this.settled) {
      this.addChild(new Text(this.palette.dim(t('aside.noAnswer')), 0, 0))
    } else {
      this.addChild(new Text(this.palette.dim('…'), 0, 0))
    }
  }
}
