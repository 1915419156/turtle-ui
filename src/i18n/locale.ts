/**
 * Language identity and environment resolution for the terminal front door.
 * The terminal ships the same two locales as the harness client — English and
 * Chinese — and resolves `auto` from the process environment the way the Unix
 * tools do (LC_ALL, then LC_MESSAGES, then LANG).
 * @module @deepseek-ai/dsh-tui/i18n/locale
 */

/** Locales this terminal ships dictionaries for, in listing order. */
export const LOCALE_IDS = ['en', 'zh'] as const

/** One shipped locale id. */
export type LocaleId = typeof LOCALE_IDS[number]

/**
 * Configured language preference: a shipped locale, or `auto` to follow the
 * environment. This is the value the config schema accepts; {@link resolveLocale}
 * turns it into the locale that actually renders.
 */
export type LocaleSetting = 'auto' | LocaleId

/** Display name of each shipped locale, shown by `/locale`. */
export const LOCALE_LABELS: Readonly<Record<LocaleId, string>> = Object.freeze({
  en: 'English',
  zh: '中文',
})

/** Whether a string is a shipped locale id. */
export function isLocaleId(value: string): value is LocaleId {
  return (LOCALE_IDS as readonly string[]).includes(value)
}

/** Whether a string is an accepted locale setting for `/locale`. */
export function isLocaleSetting(value: string): value is LocaleSetting {
  return value === 'auto' || isLocaleId(value)
}

/**
 * Read the environment's preferred language. The first set of LC_ALL,
 * LC_MESSAGES, and LANG wins; the tag's encoding and modifier suffixes are
 * dropped (`zh_CN.UTF-8@mod` becomes `zh-CN`), and only a Chinese primary
 * subtag selects Chinese. Every other value falls back to English, including
 * `C`/`POSIX` and an environment that sets none of the three.
 *
 * @param env - Environment to read; defaults to the process environment.
 * @returns The detected locale.
 */
export function detectLocale(env: Readonly<Record<string, string | undefined>> = process.env): LocaleId {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || ''
  const tag = raw.split('.')[0]?.split('@')[0] ?? ''
  const primary = tag.replace(/_/gu, '-').split('-')[0]?.toLowerCase() ?? ''
  return primary === 'zh' ? 'zh' : 'en'
}

/**
 * Resolve a configured preference into the locale that renders. `auto` (and an
 * absent value) delegates to {@link detectLocale}; an explicit locale is used
 * as given.
 *
 * @param setting - Configured preference.
 * @param env - Environment to read for detection; defaults to the process environment.
 * @returns The locale to render with.
 */
export function resolveLocale(
  setting: LocaleSetting | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): LocaleId {
  if (setting === undefined || setting === 'auto') return detectLocale(env)
  return setting
}
