import en from './locales/en.json'
import tr from './locales/tr.json'
import de from './locales/de.json'
import es from './locales/es.json'
import fr from './locales/fr.json'
import ptBR from './locales/pt-BR.json'

export const supportedLocales = ['en', 'tr', 'de', 'es', 'fr', 'pt-BR'] as const
export type SupportedLocale = typeof supportedLocales[number]

export const localeResources = {
  en: { translation: en },
  tr: { translation: tr },
  de: { translation: de },
  es: { translation: es },
  fr: { translation: fr },
  'pt-BR': { translation: ptBR },
} as const

export const localeOptions: ReadonlyArray<{ code: SupportedLocale; labelKey: string }> = [
  { code: 'en', labelKey: 'englishLanguage' },
  { code: 'tr', labelKey: 'turkishLanguage' },
  { code: 'de', labelKey: 'germanLanguage' },
  { code: 'es', labelKey: 'spanishLanguage' },
  { code: 'fr', labelKey: 'frenchLanguage' },
  { code: 'pt-BR', labelKey: 'portugueseBrazilLanguage' },
]

export function isSupportedLocale(value: string): value is SupportedLocale {
  return supportedLocales.some((locale) => locale === value)
}
