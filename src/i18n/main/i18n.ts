import i18next, { type TFunction } from 'i18next';
import en from '../catalogs/en.json';
import zhHans from '../catalogs/zh-Hans.json';
import { resolveLanguage } from '../shared/language';

// Translates a catalog key, with its values, as react-i18next's t does in the window.
export type Translate = TFunction;

// Translates the main process's own strings, such as those of the dialogs and menus it shows, in the
// language picked from the preferred languages, as the window picks its own. The text goes to native
// dialogs and to the menus and questions a window's page draws, which show it as text, never as
// markup, so values are not escaped.
export function mainTranslator(preferred: readonly string[]): Translate {
  const language = resolveLanguage(preferred);
  const instance = i18next.createInstance();
  void instance.init({
    resources: { en: { translation: en }, 'zh-Hans': { translation: zhHans } },
    lng: language,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  return instance.getFixedT(language);
}
