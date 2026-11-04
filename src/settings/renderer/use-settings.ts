import { useEffect, useState } from 'react';
import { switchLanguage } from '../../i18n/renderer/i18n';
import { preferredLanguages, type AppSettings, type SettingsBridge } from '../shared/settings';

export interface SettingsState {
  settings: AppSettings;
  change: (change: Partial<AppSettings>) => void;
}

// The app's settings, kept current through the bridge, and what changes them. The window's language
// follows the language setting; the appearance needs nothing here, since the main process sets the
// appearance the window's page follows.
export function useSettings(bridge: SettingsBridge): SettingsState {
  const [settings, setSettings] = useState(bridge.initial);

  useEffect(() => {
    let live = true;
    const stop = bridge.onChange(setSettings);
    bridge.get().then((current) => {
      if (live) setSettings(current);
    }, report);
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);

  useEffect(() => {
    switchLanguage(preferredLanguages(settings.language, navigator.languages));
  }, [settings.language]);

  return {
    settings,
    change: (change) => {
      bridge.set(change).catch(report);
    },
  };
}

function report(error: unknown): void {
  console.error('The settings could not be read or changed:', error);
}
