/**
 * Keyboard picker over a session's restore points. Selecting a row forks the
 * session at that boundary; the newest row branches without rewinding.
 * @module @deepseek-ai/dsh-tui/components/rewind-picker
 */

import {
  Key,
  SelectList,
  matchesKey,
  visibleWidth,
  type Component,
  type SelectItem,
} from '@earendil-works/pi-tui'
import { displayText } from './text.ts'
import { dialogSelectTheme, type Palette } from './theme.ts'
import { renderDialog } from './dialogs.ts'
import type { RestorePoint } from '../chat/rewind.ts'
import type { Translator } from '../i18n/translate.ts'

/**
 * Modal list of a session's fork boundaries, newest first. Up/Down move, Enter
 * forks at the highlighted point, and Esc cancels without changing anything.
 */
export class RewindPicker implements Component {
  /** pi-tui focus flag; the overlay host sets it while the picker is shown. */
  focused = false
  private readonly list: SelectList
  private readonly points: Map<string, RestorePoint>

  constructor(
    points: readonly RestorePoint[],
    maxVisible: number,
    private readonly palette: Palette,
    private readonly choose: (point: RestorePoint) => void,
    private readonly cancel: () => void,
    private readonly translator: Translator,
  ) {
    const index = new Map<string, RestorePoint>()
    const items: SelectItem[] = points.map((point) => {
      const value = String(point.boundary)
      index.set(value, point)
      // The list reserves a fixed-width primary column, so the prompt rides in
      // the description where it has the row's remaining width to itself.
      const description = [point.prompt, point.detail]
        .filter((part): part is string => part !== undefined && part !== '')
        .join(' · ')
      return {
        value,
        label: `${point.head ? '⑂' : '↺'} ${displayText(point.short)}`,
        description: displayText(description),
      }
    })
    this.points = index
    this.list = new SelectList(items, maxVisible, dialogSelectTheme(palette), {
      // Size the primary column to the widest label actually present, so the
      // description starts immediately after it.
      minPrimaryColumnWidth: Math.max(...items.map(item => visibleWidth(item.label))) + 2,
      maxPrimaryColumnWidth: Math.max(...items.map(item => visibleWidth(item.label))) + 2,
    })
    this.list.onSelect = (item) => {
      const point = this.points.get(item.value)
      /* v8 ignore next -- SelectList only returns values built from `points`. */
      if (point !== undefined) this.choose(point)
    }
    this.list.onCancel = cancel
  }

  invalidate(): void {
    this.list.invalidate()
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) this.cancel()
    else this.list.handleInput(data)
    this.invalidate()
  }

  render(width: number): string[] {
    const { t } = this.translator
    return renderDialog(t('rewind.title'), [
      ...this.list.render(Math.max(1, width - 4)),
      '',
      this.palette.dim(t('rewind.footer')),
      this.palette.dim(t('rewind.note')),
    ], width, this.palette)
  }
}
