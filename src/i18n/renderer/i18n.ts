import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../catalogs/en.json';
import zhHans from '../catalogs/zh-Hans.json';
import { resolveLanguage, type Language } from '../shared/language';

// Starts the localization runtime that react-i18next's useTranslation reads, in the language picked
// from the preferred languages, and marks the page with that language so that VoiceOver reads it
// with a matching voice. In Electron, navigator.languages lists the languages preferred in macOS's
// settings, most preferred first.
export function initI18n(preferred: readonly string[] = navigator.languages): Language {
  const language = resolveLanguage(preferred);
  void i18next.use(initReactI18next).init({
    resources: { en: { translation: en }, 'zh-Hans': { translation: zhHans } },
    lng: language,
    fallbackLng: 'en',
    // React escapes what it renders.
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  document.documentElement.lang = language;
  return language;
}

// Picks the window's language again from the preferred languages, as the user's choice of language
// changes, and marks the page with it.
export function switchLanguage(preferred: readonly string[]): Language {
  const language = resolveLanguage(preferred);
  void i18next.changeLanguage(language);
  document.documentElement.lang = language;
  return language;
}
