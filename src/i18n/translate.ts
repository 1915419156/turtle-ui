/**
 * Translation runtime for the terminal front door. `zh` owns the key set;
 * `en` is checked complete against it at compile time, so the two shipped
 * locales cannot drift. English entries may be functions when the source text
 * needs a plural form, which Chinese does not carry.
 * @module @deepseek-ai/dsh-tui/i18n/translate
 */

import { LOCALE_IDS, type LocaleId } from './locale.ts'
import { en } from './locales/en.ts'
import { zh, type TranslationKey } from './locales/zh.ts'

export type { TranslationKey }

/** Values a template may interpolate. */
export type TParams = Readonly<Record<string, string | number | boolean>>

/**
 * One dictionary entry: a template with `{name}` placeholders, or a function
 * that composes the text itself (plural forms, and any other grammar a locale
 * needs that a placeholder substitution cannot express).
 */
export type TranslationEntry = string | ((params: TParams) => string)

/** A complete dictionary of the shipped key set. */
export type Dictionary = Record<TranslationKey, TranslationEntry>

/** The shipped dictionaries, keyed by locale. */
export const DICTIONARIES: Readonly<Record<LocaleId, Dictionary>> = Object.freeze({ en, zh })

/**
 * Translate one key. A function entry composes its own text; a template entry
 * substitutes every `{name}` it names, leaving an unknown placeholder and a
 * missing argument's placeholder visible rather than dropping the text around
 * them, so a broken key reads as a broken key.
 *
 * @param locale - Locale to translate into.
 * @param key - Translation key.
 * @param params - Values for the entry's placeholders.
 * @returns The translated text.
 */
export function translate(locale: LocaleId, key: TranslationKey, params: TParams = {}): string {
  const entry = DICTIONARIES[locale][key]
  if (typeof entry === 'function') return entry(params)
  return entry.replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * A locale-bound translator, handed to every component that renders copy.
 *
 * `t` reads {@link Translator.locale} on every call rather than closing over a
 * locale, so it is a stable reference: a controller may hold `deps.translator.t`
 * across a language switch and still render the new language. Reassigning
 * `locale` is therefore the whole of {@link retargetTranslator}.
 */
export interface Translator {
  /** Locale this translator renders. */
  locale: LocaleId
  /** Translate one key in this translator's current locale. */
  t: (key: TranslationKey, params?: TParams) => string
}

/**
 * Bind one locale for repeated translation.
 * @param locale - Locale to render.
 * @returns The bound translator.
 */
export function createTranslator(locale: LocaleId): Translator {
  const translator: Translator = {
    locale,
    t: (key, params) => translate(translator.locale, key, params),
  }
  return translator
}

/**
 * Point an existing translator at another locale, in place. Every holder of the
 * reference therefore renders the new language from its next render on, which
 * is what makes a mid-session language switch a rebuild rather than a re-wiring.
 *
 * @param translator - Translator to retarget.
 * @param locale - Locale it should render from now on.
 */
export function retargetTranslator(translator: Translator, locale: LocaleId): void {
  translator.locale = locale
}

/** Whether a value is a shipped locale; re-exported for config and command validation. */
export { LOCALE_IDS, LOCALE_LABELS, isLocaleId, isLocaleSetting, resolveLocale, detectLocale } from './locale.ts'
export type { LocaleId, LocaleSetting } from './locale.ts'
