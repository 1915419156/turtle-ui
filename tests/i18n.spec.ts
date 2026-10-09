/**
 * The terminal's interface-language layer: environment detection, key-set
 * completeness between the two shipped dictionaries, and placeholder
 * substitution for both template and function entries.
 */

import { describe, expect, it } from 'vitest'
import {
  detectLocale,
  isLocaleId,
  isLocaleSetting,
  LOCALE_IDS,
  LOCALE_LABELS,
  resolveLocale,
} from '../src/i18n/locale.ts'
import {
  createTranslator,
  DICTIONARIES,
  retargetTranslator,
  translate,
  type Dictionary,
  type TranslationKey,
} from '../src/i18n/translate.ts'
import { zh } from '../src/i18n/locales/zh.ts'

describe('locale identity', () => {
  it('ships exactly the two languages the harness client ships', () => {
    expect([...LOCALE_IDS]).toEqual(['en', 'zh'])
    expect(Object.keys(LOCALE_LABELS).sort()).toEqual(['en', 'zh'])
  })

  it('recognizes shipped ids and the three accepted settings', () => {
    expect(isLocaleId('en')).toBe(true)
    expect(isLocaleId('zh')).toBe(true)
    expect(isLocaleId('ja')).toBe(false)
    expect(isLocaleId('')).toBe(false)
    for (const setting of ['auto', 'en', 'zh']) expect(isLocaleSetting(setting)).toBe(true)
    expect(isLocaleSetting('AUTO')).toBe(false)
    expect(isLocaleSetting('zh-CN')).toBe(false)
  })
})

describe('environment detection', () => {
  it('reads LC_ALL, then LC_MESSAGES, then LANG', () => {
    expect(detectLocale({ LANG: 'zh_CN.UTF-8' })).toBe('zh')
    expect(detectLocale({ LANG: 'en_US.UTF-8' })).toBe('en')
    expect(detectLocale({ LC_ALL: 'zh_CN.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh')
    expect(detectLocale({ LC_MESSAGES: 'zh_TW.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh')
    // An empty LC_ALL is not a selection, so the next variable decides.
    expect(detectLocale({ LC_ALL: '', LANG: 'zh_CN.UTF-8' })).toBe('zh')
  })

  it('normalizes tag spelling, encoding, and modifier suffixes', () => {
    expect(detectLocale({ LANG: 'zh' })).toBe('zh')
    expect(detectLocale({ LANG: 'zh-CN' })).toBe('zh')
    expect(detectLocale({ LANG: 'zh_CN.UTF-8@modifier' })).toBe('zh')
    expect(detectLocale({ LANG: 'ZH_cn.utf8' })).toBe('zh')
  })

  it('falls back to English for any other language and an unset environment', () => {
    expect(detectLocale({ LANG: 'fr_FR.UTF-8' })).toBe('en')
    expect(detectLocale({ LANG: 'ja_JP.UTF-8' })).toBe('en')
    expect(detectLocale({ LANG: 'C' })).toBe('en')
    expect(detectLocale({ LANG: 'POSIX' })).toBe('en')
    expect(detectLocale({})).toBe('en')
  })
})

describe('locale resolution', () => {
  it('treats auto and an absent value as "follow the environment"', () => {
    expect(resolveLocale(undefined, { LANG: 'zh_CN.UTF-8' })).toBe('zh')
    expect(resolveLocale('auto', { LANG: 'zh_CN.UTF-8' })).toBe('zh')
    expect(resolveLocale('auto', { LANG: 'en_US.UTF-8' })).toBe('en')
  })

  it('lets an explicit locale win over the environment', () => {
    expect(resolveLocale('en', { LANG: 'zh_CN.UTF-8' })).toBe('en')
    expect(resolveLocale('zh', { LANG: 'en_US.UTF-8' })).toBe('zh')
  })
})

describe('dictionary completeness', () => {
  // `en` is typed as a complete map of the `zh` key set, so a shortfall is a
  // compile error; this guards the other direction — a key in `en` that the
  // source of truth no longer has.
  it('has no key outside the Chinese source of truth', () => {
    const source = new Set(Object.keys(zh))
    for (const key of Object.keys(DICTIONARIES.en as Dictionary)) {
      expect(source.has(key as TranslationKey)).toBe(true)
    }
  })

  it('renders every key in both locales without leaving a placeholder behind', () => {
    // Every placeholder any shipped template names gets a value, so this proves
    // the dictionaries' placeholders are supplyable rather than that the test
    // happened to list the right names by hand.
    const params: Record<string, string | number | boolean> = {}
    for (const dictionary of [DICTIONARIES.en, DICTIONARIES.zh]) {
      for (const entry of Object.values(dictionary)) {
        if (typeof entry !== 'string') continue
        for (const match of entry.matchAll(/\{(\w+)\}/gu)) params[match[1] as string] = 'value'
      }
    }
    params.count = 1
    params.multi = false
    for (const key of Object.keys(zh) as TranslationKey[]) {
      for (const locale of LOCALE_IDS) {
        expect(translate(locale, key, params), `${locale} ${key}`).not.toMatch(/\{\w+\}/u)
      }
    }
  })
})

describe('translation', () => {
  it('substitutes template placeholders and leaves an unknown one visible', () => {
    expect(translate('en', 'count.event', { count: 3 })).toBe('3 events')
    expect(translate('zh', 'count.event', { count: 3 })).toBe('3 个事件')
    // A missing argument leaves its placeholder in place rather than printing
    // "undefined" or silently dropping the surrounding text.
    expect(translate('en', 'tool.header')).toBe('Tool / {name}')
    expect(translate('zh', 'tool.header')).toBe('工具 / {name}')
  })

  it('pluralizes through a function entry where the language needs it', () => {
    // English distinguishes 1 from n; Chinese does not carry the distinction.
    expect(translate('en', 'count.toolCall', { count: 1 })).toBe('1 tool call')
    expect(translate('en', 'count.toolCall', { count: 2 })).toBe('2 tool calls')
    expect(translate('en', 'mcp.toolCount', { count: 1 })).toBe('1 tool')
    expect(translate('en', 'diff.files', { count: 1 })).toBe('1 file')
    expect(translate('zh', 'mcp.toolCount', { count: 1 })).toBe('1 个工具')
    expect(translate('zh', 'mcp.toolCount', { count: 5 })).toBe('5 个工具')
  })

  it('keeps the same English text the terminal rendered before localization', () => {
    // Spot checks across the surfaces the dictionaries replaced, so a later
    // "improvement" to the English copy is a deliberate act, not an accident.
    expect(translate('en', 'role.you')).toBe('You')
    expect(translate('en', 'role.assistant')).toBe('Assistant')
    expect(translate('en', 'tool.header', { name: 'bash' })).toBe('Tool / bash')
    expect(translate('en', 'prompt.compacting', { duration: '1.0s' })).toBe('Context being compacted 1.0s')
    expect(translate('en', 'resume.titlePositioned', { position: 2, total: 5 })).toBe('Resume session (2 of 5)')
    expect(translate('en', 'notice.retrying', { retry: 1, limit: 3, delayMs: 500, failure: 'boom' }))
      .toBe('Retrying model request (1/3) in 500ms: boom')
  })
})

describe('prompt fragments', () => {
  it('renders the unset-workspace label in the active language', async () => {
    const { formatCwd } = await import('../src/chat/helpers.ts')
    expect(formatCwd(undefined, createTranslator('en').t)).toBe('cwd unset')
    expect(formatCwd(undefined, createTranslator('zh').t)).toBe('工作目录未设置')
    // A real path is locale-independent: only the unset label is copy.
    expect(formatCwd('/tmp', createTranslator('zh').t)).toBe('/tmp')
  })
})

describe('translator retargeting', () => {
  it('switches the locale of one shared translator in place', () => {
    const translator = createTranslator('en')
    const t = translator.t
    expect(t('role.you')).toBe('You')

    // The bound function changes too, so a holder that captured `t` earlier
    // renders the new language from its next call on.
    retargetTranslator(translator, 'zh')
    expect(translator.locale).toBe('zh')
    expect(t('role.you')).toBe('你')
    expect(translator.t('role.assistant')).toBe('助手')
  })
})
