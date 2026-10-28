import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { createBridge } from './bridge';

// The preload script, which runs in the sandboxed page before it loads and gives it the bridge as
// window.bridge. webUtils finds a dropped file's path, which the page itself cannot see.
contextBridge.exposeInMainWorld(
  'bridge',
  createBridge(ipcRenderer, (file) => webUtils.getPathForFile(file)),
);
