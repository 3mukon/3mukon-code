import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, shell } from 'electron';
import type { AppSettings } from '../../settings/shared/settings';
import { settingsSwitch } from '../shared/bridge';
import { isWebUrl } from './links';

// The page the window shows: electron-vite dev serves the renderer and sets this variable, which a
// packaged app ignores; otherwise the built page.
export function pageUrl(): string {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devServerUrl) return devServerUrl;
  return pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).href;
}

// The app's window, whose page starts in the settings given, the language among them.
export function createMainWindow(settings: AppSettings): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    titleBarStyle: 'hiddenInset',
    // The traffic lights, 14pt tall, 13pt from the top, so that they are centred in the page's 40px
    // title bar, on one line with what the page shows beside them and in the panels' headers; hidden
    // inset's own 11pt sets them 2pt higher. The 12pt from the left is hidden inset's own.
    trafficLightPosition: { x: 12, y: 13 },
    webPreferences: {
      // The preload script gives the sandboxed page the bridge, its only way to the main process. A
      // sandboxed preload script runs as CommonJS.
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [settingsSwitch + encodeURIComponent(JSON.stringify(settings))],
    },
  });
  window.once('ready-to-show', () => {
    window.show();
  });

  // The window only ever shows the app's own page: it opens no other windows and navigates nowhere
  // else, and web links go to the default browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openWebLink(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault();
    openWebLink(event.url);
  });

  void window.loadURL(pageUrl());
  return window;
}

function openWebLink(url: string): void {
  if (isWebUrl(url)) void shell.openExternal(url);
}
