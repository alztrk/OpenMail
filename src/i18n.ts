import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { localeResources, supportedLocales } from './locale-config'
import { loadSettings } from './settings'

void i18n.use(initReactI18next).init({
  resources: localeResources,
  lng: loadSettings().language,
  fallbackLng: 'en',
  supportedLngs: supportedLocales,
  load: 'currentOnly',
  interpolation: { escapeValue: false },
})

export default i18n
