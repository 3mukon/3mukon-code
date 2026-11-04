import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppSettings } from '../shared/settings';
import { Settings, settingsStorage, type SettingsStorage } from './settings';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const made = mkdtempSync(join(tmpdir(), 'settings-'));
  folders.push(made);
  return made;
}

function memory(start: AppSettings = { language: 'system', appearance: 'system' }) {
  const saved: AppSettings[] = [];
  const storage: SettingsStorage = {
    load: () => start,
    save: (settings) => saved.push(settings),
  };
  return { storage, saved };
}

describe('Settings', () => {
  it('changes and saves a setting, telling its listeners, and changes nothing to the same', () => {
    const { storage, saved } = memory();
    const settings = new Settings(storage);
    const heard: AppSettings[] = [];
    const stop = settings.onChange((current) => heard.push(current));
    settings.set({ appearance: 'dark' });
    settings.set({ appearance: 'dark' });
    expect(settings.get()).toEqual({ language: 'system', appearance: 'dark' });
    expect(saved).toEqual([{ language: 'system', appearance: 'dark' }]);
    expect(heard).toEqual(saved);
    stop();
    settings.set({ language: 'zh-Hans' });
    expect(heard).toHaveLength(1);
    expect(saved.at(-1)).toEqual({ language: 'zh-Hans', appearance: 'dark' });
  });

  it('keeps the settings in settings.json, readable by the user alone, and starts from the defaults', () => {
    const data = folder();
    expect(settingsStorage(data).load()).toEqual({ language: 'system', appearance: 'system' });
    new Settings(settingsStorage(data)).set({ language: 'en', appearance: 'light' });
    const file = join(data, 'settings.json');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ language: 'en', appearance: 'light' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new Settings(settingsStorage(data)).get()).toEqual({
      language: 'en',
      appearance: 'light',
    });
  });

  it('lets a value that is not one of the choices, or a file that is not JSON, give way to the default', () => {
    const data = folder();
    const file = join(data, 'settings.json');
    writeFileSync(file, JSON.stringify({ language: 'fr', appearance: 'dark' }));
    expect(settingsStorage(data).load()).toEqual({ language: 'system', appearance: 'dark' });
    writeFileSync(file, 'not json');
    expect(settingsStorage(data).load()).toEqual({ language: 'system', appearance: 'system' });
  });
});
