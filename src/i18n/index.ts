/**
 * Public interface-language surface for `@deepseek-ai/dsh-tui`: the shipped
 * locale ids and labels, environment detection, and the translator an embedder
 * binds to render the terminal's copy in one language.
 * @module @deepseek-ai/dsh-tui/i18n
 */

export {
  detectLocale,
  isLocaleId,
  isLocaleSetting,
  LOCALE_IDS,
  LOCALE_LABELS,
  resolveLocale,
  type LocaleId,
  type LocaleSetting,
} from './locale.ts'
export {
  createTranslator,
  retargetTranslator,
  translate,
  type TranslationKey,
  type Translator,
  type TParams,
} from './translate.ts'
