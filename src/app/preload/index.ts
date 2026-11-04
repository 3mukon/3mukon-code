import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { settingsOf, type AppSettings } from '../../settings/shared/settings';
import { settingsSwitch } from '../shared/bridge';
import { createBridge } from './bridge';

// The preload script, which runs in the sandboxed page before it loads and gives it the bridge as
// window.bridge. webUtils finds a dropped file's path, which the page itself cannot see, and the
// window's command line holds the settings it opened with.
contextBridge.exposeInMainWorld(
  'bridge',
  createBridge(ipcRenderer, (file) => webUtils.getPathForFile(file), openingSettings()),
);

// The settings the main process gave the window as it opened, or the defaults.
function openingSettings(): AppSettings {
  const given = process.argv.find((argument) => argument.startsWith(settingsSwitch));
  try {
    return settingsOf(
      given === undefined ? {} : JSON.parse(decodeURIComponent(given.slice(settingsSwitch.length))),
    );
  } catch {
    return settingsOf({});
  }
}
