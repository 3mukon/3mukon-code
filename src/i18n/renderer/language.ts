export type Language = 'en' | 'zh-Hans';

// Picks the UI language from the user's preferred languages, most preferred first, as BCP 47 tags
// such as en-US, zh-CN or zh-Hans-CN. The first English or Simplified Chinese tag wins; other
// languages, Traditional Chinese among them, are skipped, and English is the fallback.
export function resolveLanguage(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    let locale: Intl.Locale;
    try {
      locale = new Intl.Locale(tag).maximize();
    } catch {
      continue;
    }
    if (locale.language === 'en') return 'en';
    if (locale.language === 'zh' && locale.script === 'Hans') return 'zh-Hans';
  }
  return 'en';
}
