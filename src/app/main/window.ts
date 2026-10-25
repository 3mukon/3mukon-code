import { join } from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { isWebUrl } from './links';

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
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

  // electron-vite dev serves the renderer and sets this variable; a packaged app ignores it.
  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devServerUrl) {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return window;
}

function openWebLink(url: string): void {
  if (isWebUrl(url)) void shell.openExternal(url);
}
