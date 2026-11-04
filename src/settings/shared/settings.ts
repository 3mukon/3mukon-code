import type { Language } from '../../i18n/shared/language';

// The language the user chose: macOS's preferred languages, or one of the app's own.
export type LanguageChoice = 'system' | Language;

// The appearance the user chose: macOS's, or light or dark whatever macOS uses.
export type Appearance = 'system' | 'light' | 'dark';

// The app's settings.
export interface AppSettings {
  language: LanguageChoice;
  appearance: Appearance;
}

export const defaultSettings: AppSettings = { language: 'system', appearance: 'system' };

const languages: readonly LanguageChoice[] = ['system', 'en', 'zh-Hans'];
const appearances: readonly Appearance[] = ['system', 'light', 'dark'];

// What the window asks of the settings, through the preload bridge.
export interface SettingsBridge {
  // The settings as they were when the window opened, which it starts in.
  initial: AppSettings;
  get(): Promise<AppSettings>;
  // Changes some of the settings, which every window hears.
  set(change: Partial<AppSettings>): Promise<void>;
  // Calls the listener with the settings whenever they change, and returns a function that stops it.
  onChange(listener: (settings: AppSettings) => void): () => void;
}

// The settings a value of any shape holds, as storage or the command line gives them: what is not
// one of the choices gives way to the default.
export function settingsOf(value: unknown): AppSettings {
  const given = typeof value === 'object' && value !== null ? value : {};
  const language = 'language' in given ? given.language : undefined;
  const appearance = 'appearance' in given ? given.appearance : undefined;
  return {
    language: languages.find((choice) => choice === language) ?? defaultSettings.language,
    appearance: appearances.find((choice) => choice === appearance) ?? defaultSettings.appearance,
  };
}

// The preferred languages a choice of language stands for: macOS's, or the one chosen.
export function preferredLanguages(
  choice: LanguageChoice,
  system: readonly string[],
): readonly string[] {
  return choice === 'system' ? system : [choice];
}
