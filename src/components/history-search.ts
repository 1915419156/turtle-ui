/**
 * Searchable prompt-history panel. pi-tui's editor owns arrow-key history, but
 * it is unbounded and unsearchable; this overlay searches the channel's bounded
 * {@link InputHistory} mirror and hands the selected prompt back to the editor.
 * @module @deepseek-ai/dsh-tui/components/history-search
 */

import {
  Input,
  Key,
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SelectItem,
} from '@earendil-works/pi-tui'
import { displayText } from './text.ts'
import { dialogSelectTheme, type Palette } from './theme.ts'
import { renderDialog } from './dialogs.ts'
import { summarizeHistoryEntry, type HistoryMatch } from '../chat/history.ts'
import type { Translator } from '../i18n/translate.ts'

/**
 * One submission's local wall-clock time. A timestamp is a hint for picking
 * between similar prompts, so the row shows the compact clock alone; the full
 * date belongs in the prompt itself, not in a search list.
 */
function clockTime(at: number): string {
  const date = new Date(at)
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(value => value.toString().padStart(2, '0'))
    .join(':')
}

/**
 * Reverse-chronological fuzzy prompt search. Typing filters live; Enter hands
 * the highlighted entry back through `select`, Escape clears the query before
 * it closes — the same two-stage dismissal every other TUI selector uses.
 */
export class HistorySearchDialog implements Component {
  private readonly filter = new Input()
  private list: SelectList

  constructor(
    private readonly matches: (query: string, limit: number) => readonly HistoryMatch[],
    private readonly maxVisible: number,
    private readonly palette: Palette,
    private readonly select: (text: string) => void,
    private readonly cancel: () => void,
    private readonly translator: Translator,
  ) {
    this.list = this.buildList()
  }

  private filtered(): HistoryMatch[] {
    return [...this.matches(this.filter.getValue(), this.maxVisible)]
  }

  private buildList(): SelectList {
    const rows = this.filtered()
    const items: SelectItem[] = rows.map((match, index) => ({
      // The editor hands text back on selection, so the value is the row index:
      // two entries may legitimately carry identical prompt text.
      value: String(index),
      label: displayText(summarizeHistoryEntry(match.entry.text)),
      description: displayText(clockTime(match.entry.at)),
    }))
    // The list reserves a fixed-width primary column. Sizing it to the widest
    // prompt actually present keeps every row's timestamp in one aligned column
    // and gives the prompt the rest of the row instead of a fixed 32 columns.
    // The cap keeps the timestamp column from being squeezed on a narrow dialog.
    const primary = Math.min(
      Math.max(...items.map(item => visibleWidth(item.label))) + 2,
      44,
    )
    const list = new SelectList(items, this.maxVisible, dialogSelectTheme(this.palette), {
      minPrimaryColumnWidth: primary,
      maxPrimaryColumnWidth: primary,
    })
    list.onSelect = (item) => {
      const row = this.filtered()[Number(item.value)]
      /* v8 ignore next -- SelectList only returns values built from the same rows. */
      if (row === undefined) return
      this.select(row.entry.text)
    }
    list.onCancel = this.cancel
    return list
  }

  invalidate(): void {
    this.filter.invalidate()
    this.list.invalidate()
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.filter.getValue() === '') this.cancel()
      else {
        this.filter.setValue('')
        this.list = this.buildList()
      }
    } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.list.handleInput(data)
    } else {
      const previous = this.filter.getValue()
      this.filter.focused = true
      this.filter.handleInput(data)
      if (this.filter.getValue() !== previous) this.list = this.buildList()
    }
    this.invalidate()
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 4)
    this.filter.focused = true
    const rows = this.filtered()
    const filterContent = truncateToWidth(this.filter.render(innerWidth).join(''), innerWidth, '')
    const { t } = this.translator
    return renderDialog(t('history.title'), [
      filterContent,
      '',
      ...rows.length === 0
        ? [this.palette.dim(t('history.noMatch'))]
        : this.list.render(innerWidth),
      '',
      this.palette.dim(t('history.footer')),
    ], width, this.palette)
  }
}
