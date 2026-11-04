import i18next, { type TFunction } from 'i18next';
import en from '../catalogs/en.json';
import zhHans from '../catalogs/zh-Hans.json';
import { resolveLanguage } from '../shared/language';

// Translates a catalog key, with its values, as react-i18next's t does in the window.
export type Translate = TFunction;

// The main process's translator, whose language follows the user's choice while the app runs.
export interface SwitchableTranslator {
  // Translates in the language last picked.
  t: Translate;
  // Picks the language again from the preferred languages.
  use(preferred: readonly string[]): void;
}

// Translates the main process's own strings, such as those of the dialogs and menus it shows, in the
// language picked from the preferred languages, as the window picks its own. The text goes to native
// dialogs and to the menus and questions a window's page draws, which show it as text, never as
// markup, so values are not escaped.
export function mainTranslator(preferred: readonly string[]): Translate {
  return switchableTranslator(preferred).t;
}

// A translator like mainTranslator's, whose language can be picked again.
export function switchableTranslator(preferred: readonly string[]): SwitchableTranslator {
  const instance = i18next.createInstance();
  void instance.init({
    resources: { en: { translation: en }, 'zh-Hans': { translation: zhHans } },
    lng: resolveLanguage(preferred),
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    initAsync: false,
  });
  return {
    // Without a language of its own, it translates in the instance's language of the moment.
    t: instance.getFixedT(null, 'translation'),
    use: (next) => {
      void instance.changeLanguage(resolveLanguage(next));
    },
  };
}
