import { useTranslation } from 'react-i18next';
import { Segmented } from '../../ui/renderer/segmented';
import type { Appearance, AppSettings, LanguageChoice } from '../shared/settings';

interface SettingsPanelProps {
  settings: AppSettings;
  onChange: (change: Partial<AppSettings>) => void;
}

// The settings, as a panel shows them on the window's paper: the window's language, System taking
// macOS's preferred languages and each language named in itself, and its appearance, each a row of
// choices with the chosen one in ink.
export function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  const { t } = useTranslation();
  return (
    // Positioned, as every scroll area is (L-0001).
    <div className="relative min-h-0 overflow-y-auto">
      <div className="flex max-w-md flex-col gap-6 px-5 pt-3 pb-5">
        <Segmented
          label={t('settings.language')}
          detail={t('settings.languageDetail')}
          value={settings.language}
          options={[
            { value: 'system', label: t('settings.system') },
            { value: 'en', label: t('settings.languages.en') },
            { value: 'zh-Hans', label: t('settings.languages.zhHans') },
          ]}
          onChange={(language) => {
            onChange({ language: language as LanguageChoice });
          }}
        />
        <Segmented
          label={t('settings.appearance')}
          detail={t('settings.appearanceDetail')}
          value={settings.appearance}
          options={[
            { value: 'system', label: t('settings.system') },
            { value: 'light', label: t('settings.light') },
            { value: 'dark', label: t('settings.dark') },
          ]}
          onChange={(appearance) => {
            onChange({ appearance: appearance as Appearance });
          }}
        />
      </div>
    </div>
  );
}
