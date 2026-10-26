import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../catalogs/en.json';
import zhHans from '../catalogs/zh-Hans.json';
import { resolveLanguage, type Language } from './language';

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
