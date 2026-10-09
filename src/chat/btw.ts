/**
 * `/btw` — a side question answered outside the session log. The question and
 * its answer never enter the durable conversation: the request is built from the
 * same surface the agent would send (so the answer is informed by the work so
 * far), and the reply streams into a transcript card the model never sees again.
 *
 * This module owns the request; `components/aside.ts` owns the card that shows
 * the streamed answer, and the calling command decides where that card lives.
 * @module @deepseek-ai/dsh-tui/chat/btw
 */

import { createTranslator, type Translator } from '../i18n/translate.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { Context } from '@deepseek-ai/cordis'

/** Result of one side question: the assembled answer, or a reported failure. */
export type SideAnswer =
  | { readonly kind: 'answer'; readonly text: string; readonly reasoning: string }
  | { readonly kind: 'error'; readonly message: string }

/** Callbacks a side-question run reports through. */
export interface SideQuestionSink {
  /** Called for each streamed chunk, in order. */
  readonly onChunk: (chunk: StreamChunk) => void
  /** Called once when the run settles; not called after cancellation. */
  readonly onDone: (answer: SideAnswer) => void
}

/**
 * Build the request message list a side question is asked under: the model's
 * current surface (with replacements applied) plus the question itself. The
 * system prompt is contributed separately, exactly as a normal turn does it.
 *
 * `Session.deriveMessages` is the same derivation the agent loop folds for a
 * real request, so the answer is informed by exactly what the model last saw —
 * including a compaction that has already replaced history.
 *
 * @param session - Live session whose surface informs the answer.
 * @param question - The user's side question.
 * @returns The ordered request messages.
 */
export function sideQuestionMessages(session: Session, question: string): Message[] {
  return [
    ...session.deriveMessages(),
    createUserMessage({
      content: [{ type: 'text', text: question }],
      source: { kind: 'user' },
    }),
  ]
}

/** Accumulated streamed content of one side-question attempt. */
export class SideAnswerBuffer {
  private readonly text: string[] = []
  private readonly reasoning: string[] = []

  /**
   * Fold one streamed chunk into the buffer.
   * @param chunk - Streamed assistant chunk.
   */
  accept(chunk: StreamChunk): void {
    if (chunk.type === 'text-delta') this.text.push(chunk.text)
    else if (chunk.type === 'reasoning-delta') this.reasoning.push(chunk.text)
    else if (chunk.type === 'block-end') {
      // A settled block replaces whatever the deltas accumulated for its index;
      // appending could double it, so only fill in when nothing streamed yet.
      if (chunk.block.type === 'text' && this.text.length === 0 && chunk.block.text !== '') {
        this.text.push(chunk.block.text)
      } else if (chunk.block.type === 'reasoning' && this.reasoning.length === 0 && chunk.block.text !== '') {
        this.reasoning.push(chunk.block.text)
      }
    }
  }

  /** The answer text streamed so far. */
  get answer(): string {
    return this.text.join('')
  }

  /** The reasoning text streamed so far. */
  get thinking(): string {
    return this.reasoning.join('')
  }
}

/**
 * Ask one side question, streaming the answer.
 *
 * The call is a plain one-shot LLM request: it does not touch the agent's loop,
 * tools, or session log, so it can run while a turn is in flight and leaves no
 * trace the next turn would see. Cancellation aborts the request.
 *
 * @param ctx - Context supplying the LLM service.
 * @param agent - Agent whose route and surface the question is asked under.
 * @param question - The user's side question.
 * @param signal - Cancellation for the request.
 * @param sink - Stream and completion callbacks.
 * @param t - Translator for the route-unset failure this call can report.
 */
export async function askSideQuestion(
  ctx: Context,
  agent: Agent,
  question: string,
  signal: AbortSignal,
  sink: SideQuestionSink,
  t: Translator['t'] = createTranslator('en').t,
): Promise<void> {
  const provider = agent.options.provider
  const model = agent.options.model
  if (provider === undefined || model === undefined) {
    sink.onDone({ kind: 'error', message: t('btw.noRoute') })
    return
  }
  const buffer = new SideAnswerBuffer()
  try {
    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
    if (signal.aborted) return
    const system = [
      renderPrompt(assembly),
      renderContextSnapshot(assembly),
    ].filter(section => section !== '').join('\n\n')
    const stream = ctx.llm.stream({
      provider,
      model,
      messages: sideQuestionMessages(agent.session, question),
      ...system === '' ? {} : { system },
      ...agent.options.reasoningEffort === undefined ? {} : { reasoningEffort: agent.options.reasoningEffort },
      signal,
    })
    for await (const chunk of stream) {
      if (signal.aborted) return
      buffer.accept(chunk)
      sink.onChunk(chunk)
    }
    if (signal.aborted) return
    sink.onDone({ kind: 'answer', text: buffer.answer.trim(), reasoning: buffer.thinking.trim() })
  } catch (error: unknown) {
    if (signal.aborted) return
    sink.onDone({ kind: 'error', message: errorChain(error) })
  }
}
