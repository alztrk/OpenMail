import { describe, expect, it } from 'vitest'
import { localeResources, supportedLocales } from './locale-config'

function getPlaceholders(value: string): string[] {
  return [...value.matchAll(/{{\s*([^}]+?)\s*}}/g)].map((match) => match[1]).sort()
}

describe('locale resources', () => {
  it('keeps every supported locale in sync with English', () => {
    const englishKeys = Object.keys(localeResources.en.translation).sort()

    for (const locale of supportedLocales) {
      expect(Object.keys(localeResources[locale].translation).sort(), `${locale} keys`).toEqual(englishKeys)
    }
  })

  it('does not contain blank translations or missing placeholders', () => {
    for (const key of Object.keys(localeResources.en.translation)) {
      const englishValue = localeResources.en.translation[key as keyof typeof localeResources.en.translation]

      expect(englishValue.trim(), `English translation is blank for ${key}`).not.toBe('')
      for (const locale of supportedLocales) {
        const value = localeResources[locale].translation[key as keyof typeof localeResources[typeof locale]['translation']]
        expect(value.trim(), `${locale} translation is blank for ${key}`).not.toBe('')
        expect(getPlaceholders(value), `${locale} placeholders for ${key}`).toEqual(getPlaceholders(englishValue))
      }
    }
  })
})
