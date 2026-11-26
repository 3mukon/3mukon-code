import ElectronStore from 'electron-store';
import { sameSettings, settingsOf, type AppSettings } from '../shared/settings';

export interface SettingsStorage {
  load(): AppSettings;
  save(settings: AppSettings): void;
}

// settings.json in the folder, the app's data folder (ADR-0039), readable by the user alone. A file
// that is not JSON is cleared, and a value that is not one of the choices gives way to the default.
export function settingsStorage(folder: string): SettingsStorage {
  const store = new ElectronStore<Record<string, unknown>>({
    cwd: folder,
    name: 'settings',
    configFileMode: 0o600,
    clearInvalidConfig: true,
  });
  return {
    load: () => settingsOf(store.store),
    save(settings) {
      store.store = { ...settings };
    },
  };
}

// The app's settings, kept in its data, which tell their listeners whenever they change.
export class Settings {
  private current: AppSettings;
  private readonly listeners = new Set<(settings: AppSettings) => void>();

  constructor(private readonly storage: SettingsStorage) {
    this.current = storage.load();
  }

  get(): AppSettings {
    return this.current;
  }

  // Changes some of the settings, and saves them; a change to what they are already changes nothing.
  set(change: Partial<AppSettings>): void {
    const next = settingsOf({ ...this.current, ...change });
    if (sameSettings(next, this.current)) return;
    this.current = next;
    this.storage.save(next);
    for (const listener of this.listeners) listener(next);
  }

  onChange(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
