import { contextBridge, ipcRenderer } from 'electron';
import type { ControlWindowBridge, ControlWindowSnapshot } from '../../computer/shared/computer';
import { controlChannels } from '../shared/control-window';

const bridge: ControlWindowBridge = {
  snapshot: () => ipcRenderer.invoke(controlChannels.snapshot) as Promise<ControlWindowSnapshot>,
  ready: async (revision, buttons) => {
    await ipcRenderer.invoke(controlChannels.ready, revision, buttons);
  },
  onState(listener) {
    const report = (_event: unknown, state: ControlWindowSnapshot) => {
      listener(state);
    };
    ipcRenderer.on(controlChannels.state, report);
    return () => {
      ipcRenderer.removeListener(controlChannels.state, report);
    };
  },
};

contextBridge.exposeInMainWorld('controlWindow', bridge);
