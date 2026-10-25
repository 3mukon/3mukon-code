import { app, BrowserWindow } from 'electron';
import { createMainWindow } from './window';

void app.whenReady().then(() => {
  createMainWindow();
  // Clicking the Dock icon of a running app without windows opens a new one.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  // Without this handler Electron quits; a macOS app keeps running until the user quits it.
});
