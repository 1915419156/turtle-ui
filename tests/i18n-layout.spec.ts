/**
 * CJK layout probe: the Chinese dictionary changes the *width* of every label,
 * not just its text, so wrapping, truncation, and the bordered dialogs are the
 * parts a translation can break. These render each localized surface at a narrow
 * terminal and assert that no row exceeds its width — the failure mode being a
 * box that overflows or a row that wraps into the frame below it.
 *
 * Widths are measured with `get-east-asian-width` semantics via pi-tui's own
 * `visibleWidth`, the same function the renderers use, so a disagreement here
 * would be a real disagreement on screen.
 */

import { describe, expect, it } from 'vitest'
import { visibleWidth } from '@earendil-works/pi-tui'
import { createPalette, markdownTheme } from '../src/components/theme.ts'
import {
  ApprovalDialog,
  DetailsDialog,
  ModelDialog,
  QuestionDialog,
  ResumePicker,
  StatusCardComponent,
  summarizeResumeCandidate,
  type ModelChoice,
  type StatusCardRow,
} from '../src/components/dialogs.ts'
import { HistorySearchDialog } from '../src/components/history-search.ts'
import { RewindPicker } from '../src/components/rewind-picker.ts'
import { ToolCardComponent } from '../src/components/transcript.ts'
import { parseArguments } from '../src/components/content.ts'
import { deriveRestorePoints } from '../src/chat/rewind.ts'
import { createTranslator } from '../src/i18n/translate.ts'
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionRecord } from '@deepseek-ai/dsh-session-query'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'

const palette = createPalette(false)
const mdTheme = markdownTheme(palette)
const zh = createTranslator('zh')

/** Every row of a rendered frame must fit the width it was asked for. */
function expectFits(rows: readonly string[], width: number, label: string): void {
  for (const [index, row] of rows.entries()) {
    expect(visibleWidth(row), `${label} row ${index}: ${JSON.stringify(row)}`).toBeLessThanOrEqual(width)
  }
}

/** The frame is a bordered dialog, so its rows share one exact width. */
function expectUniformWidth(rows: readonly string[], label: string): void {
  const widths = new Set(rows.map(row => visibleWidth(row)))
  expect(widths.size, `${label} row widths: ${[...widths].join(', ')}`).toBe(1)
}

/** A restore point whose label and detail both carry Chinese copy. */
function chineseSession(): Session {
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: SessionSeq(0), time: 1_000, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: SessionSeq(1),
      time: 1_001,
      data: {
        content: [{ type: 'text', text: '把吞吐率改成按路由学习，并在状态行显示实时速率' }],
        source: { kind: 'user' },
      },
    } as unknown as SessionEvent,
    { type: 'turn/end', seq: SessionSeq(2), time: 1_002, data: { turn: 1, reason: { kind: 'completed' } } } as unknown as SessionEvent,
  ]
  return { snapshotEvents: () => events } as unknown as Session
}

/** The same log with a trailing event, so the head is not a completed turn. */
function chineseSessionWithOpenTail(): Session {
  const base = chineseSession().snapshotEvents()
  return {
    snapshotEvents: () => [...base, {
      type: 'step/start', seq: SessionSeq(3), time: 1_003, data: { turn: 2, step: 1 },
    } as unknown as SessionEvent],
  } as unknown as Session
}

function record(id: string, cwd = '/workspace'): SessionRecord {
  return {
    header: { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, cwd, isSeeded: false },
    live: false,
    persisted: true,
  } as never
}

const modelChoices: readonly ModelChoice[] = [
  {
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    modelName: 'DeepSeek V4 Pro',
    description: '长上下文与推理强度可选择',
    reasoning: {
      efforts: [{ id: 'high' as never, name: '高' }, { id: 'max' as never, name: '最高' }],
    },
  },
]

const question: AskUserQuestionItem = {
  id: 'q1' as never,
  header: '部署确认',
  question: '把吞吐率改成按路由学习后，是否立即发布到线上环境？',
  options: [
    { label: '立即发布', description: '马上对全部用户生效，出问题需要回滚' },
    { label: '灰度发布', description: '先对内部用户开放，观察一天再全量' },
  ],
  multiSelect: false,
} as never

describe('Chinese layout', () => {
  it('keeps the model, details, and question dialogs inside their width', () => {
    for (const width of [40, 60, 76]) {
      expectFits(new ModelDialog(modelChoices, undefined, 8, palette, () => {}, () => {}, zh).render(width), width, `model ${width}`)
      expectFits(new DetailsDialog('collapsed', true, palette, () => {}, () => {}, zh).render(width), width, `details ${width}`)
      expectFits(new QuestionDialog(
        question, 1, 1, 1, 8, () => 12, palette, () => {}, () => {}, zh, mdTheme,
      ).render(width), width, `question ${width}`)
    }
  })

  it('keeps the Chinese question dialog bordered and aligned', () => {
    const rows = new QuestionDialog(
      question, 1, 2, 2, 8, () => 20, palette, () => {}, () => {}, zh, mdTheme,
    ).render(72)
    const rendered = rows.join('\n')
    // The question header rides in the meta line; the option labels and their
    // descriptions survive wrapping intact.
    expect(rendered).toContain('部署确认')
    expect(rendered).toContain('灰度发布')
    expect(rendered).toContain('问题 1/2（2 个未回答）')
    expect(rendered).toContain('Tab 自定义回答')
  })

  it('keeps the approval panel and its Chinese reasons inside the width', () => {
    const dialog = new ApprovalDialog(
      'bash',
      '该命令会删除构建产物目录，需要用户确认后才能执行。',
      'rm -rf dist/',
      () => 20,
      palette,
      () => {},
      () => {},
      zh,
    )
    for (const width of [40, 56, 88]) {
      const rows = dialog.render(width)
      expectFits(rows, width, `approval ${width}`)
      expectUniformWidth(rows, `approval ${width}`)
      expect(rows.join('\n')).toContain('需要批准')
      expect(rows.join('\n')).toContain('允许一次')
    }
  })

  it('keeps the Chinese resume picker rows inside the width', () => {
    const candidates = [
      summarizeResumeCandidate(record('main'), '把吞吐率改成按路由学习', 1, SessionId('other'), '/workspace', () => '(工作区)', zh),
      summarizeResumeCandidate(record('titled', '/workspace/其他项目'), undefined, 2, SessionId('other'), '/workspace', cwd => `工作区 ${cwd}`, zh),
    ]
    // The all-workspaces scope is the one that lists a row from another
    // directory and labels each row with its own workspace.
    const picker = new ResumePicker(
      candidates, 8, '工作区 /workspace', () => 32, palette, () => {}, () => {}, zh, undefined, undefined, 'all',
    )
    for (const width of [60, 80, 96]) {
      const rows = picker.render(width)
      expectFits(rows, width, `resume ${width}`)
    }
    const rendered = picker.render(80).join('\n')
    // An untitled log and the workspace label both take their Chinese text.
    expect(rendered).toContain('未命名会话')
    expect(rendered).toContain('恢复会话')
    expect(rendered).toContain('工作区')
  })

  it('keeps the archive scope and footer readable in Chinese', () => {
    const picker = new ResumePicker(
      [summarizeResumeCandidate(record('main'), '标题', 1, SessionId('main'), '/workspace', () => 'w', zh)],
      8, '/workspace', () => 32, palette, () => {}, () => {}, zh,
      () => Promise.resolve([]), () => {}, 'archived',
    )
    const rendered = picker.render(90).join('\n')
    expect(rendered).toContain('已归档')
    expectFits(picker.render(90), 90, 'archived')
  })

  it('keeps the history search and rewind pickers inside their width', () => {
    const history = new HistorySearchDialog(
      () => [{ entry: { text: '把吞吐率改成按路由学习', at: Date.now() }, score: 1 } as never],
      8, palette, () => {}, () => {}, zh,
    )
    for (const width of [50, 72]) {
      const rows = history.render(width)
      expectFits(rows, width, `history ${width}`)
      expectUniformWidth(rows, `history ${width}`)
    }
    expect(history.render(72).join('\n')).toContain('搜索历史提示词')

    const points = deriveRestorePoints(chineseSession(), zh)
    expect(points.length).toBeGreaterThan(0)
    const picker = new RewindPicker(points, 8, palette, () => {}, () => {}, zh)
    for (const width of [60, 88]) {
      const rows = picker.render(width)
      expectFits(rows, width, `rewind ${width}`)
      expectUniformWidth(rows, `rewind ${width}`)
    }
    const rendered = picker.render(88).join('\n')
    expect(rendered).toContain('回滚或分叉会话')
    // A completed turn at the log head is both the last restore point and the
    // branch-here row, so it carries the fork wording.
    expect(rendered).toContain('不回滚直接分叉')

    // An open tail (an event past the last turn end) adds the dedicated
    // "current end" row, which is the other Chinese label worth pinning.
    const open = deriveRestorePoints(chineseSessionWithOpenTail(), zh)
    const openPicker = new RewindPicker(open, 8, palette, () => {}, () => {}, zh)
    expect(openPicker.render(88).join('\n')).toContain('当前末尾')
    expectFits(openPicker.render(88), 88, 'rewind open')
  })

  it('measures the status card label column in columns, not code units', () => {
    // A CJK label occupies two columns per glyph. Measuring `label.length`
    // under-reserved the column and truncated every Chinese label to half the
    // width it needed (`工作区注册表` rendered as `工作区注册`), and code-unit
    // padding left the values unaligned.
    const rows: StatusCardRow[][] = [[
      ['工作区注册表', '未挂载'],
      ['Resume 宿主', '未挂载'],
      ['工具 schema', '0'],
    ]]
    const zhCard = new StatusCardComponent(rows, palette, 'Doctor')
    const rendered = zhCard.render(100)
    const text = rendered.join('\n')
    for (const label of ['工作区注册表:', 'Resume 宿主:', '工具 schema:']) {
      expect(text, `full label ${label}`).toContain(label)
    }
    // The values share one column. Measuring by rendered column (not by array
    // index, which CJK glyphs and ANSI escapes both distort) is what catches an
    // unaligned row.
    const valueColumns = rendered
      .filter(row => row.includes('未挂载'))
      .map(row => visibleWidth(row.slice(0, row.indexOf('未'))))
    expect(new Set(valueColumns).size).toBe(1)

    // Each card auto-sizes to its own content and keeps every frame row uniform.
    const enCard = new StatusCardComponent([[['Workspace registry', 'not mounted']]], palette, 'Doctor')
    for (const [name, card] of [['zh', zhCard], ['en', enCard]] as const) {
      const frame = card.render(100)
      expect(new Set(frame.map(row => visibleWidth(row))).size, `${name} frame uniform`).toBe(1)
      expect(visibleWidth(frame[0] as string), `${name} fitted to content`).toBeLessThan(100)
    }
    // An all-ASCII card is unaffected by the measure change (code units and
    // columns agree there), so its wording keeps its original column budget.
    const wide = new StatusCardComponent([[['Workspace registry', 'not mounted']]], palette, 'Doctor')
    expect(visibleWidth(wide.render(100)[0] as string)).toBeGreaterThan(0)
  })

  it('keeps the Chinese status card and tool card inside their width', () => {
    const card = new StatusCardComponent([
      [['会话', 'main'], ['标题', '把吞吐率改成按路由学习并在状态行显示实时速率'], ['模型', 'deepseek-v4-pro']],
    ], palette, zh.t('status.cardTitle'))
    for (const width of [48, 64, 92]) {
      expectFits(card.render(width), width, `status ${width}`)
    }

    const tool = new ToolCardComponent(
      'bash', parseArguments('{"command":"ls"}'), undefined, 10, 2_000, palette, mdTheme, 'rich', zh,
    )
    for (const width of [40, 80]) {
      expectFits(tool.render(width), width, `tool ${width}`)
    }
    expect(tool.render(80).join('\n')).toContain('工具 / bash')
  })
})
