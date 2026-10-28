import { dialog, Menu, type BrowserWindow } from 'electron';
import type { Translate } from '../../i18n/main/i18n';
import type { WorkspacesUi } from './workspaces';

// The workspaces' questions and menu as macOS shows them, for the window that asked: the folder picker
// and the trust question as sheets on the window, and a workspace's menu at the pointer.
export function nativeWorkspacesUi(window: BrowserWindow, t: Translate): WorkspacesUi {
  return {
    async pickFolder() {
      const { canceled, filePaths } = await dialog.showOpenDialog(window, {
        properties: ['openDirectory', 'createDirectory'],
        message: t('workspaces.picker.message'),
        buttonLabel: t('workspaces.picker.button'),
      });
      return canceled ? undefined : filePaths[0];
    },
    async askTrust(name, path) {
      const { response } = await dialog.showMessageBox(window, {
        type: 'question',
        message: t('workspaces.trust.message', { name }),
        detail: t('workspaces.trust.detail', { path }),
        buttons: [t('workspaces.trust.trust'), t('workspaces.trust.distrust')],
        defaultId: 0,
        // Escape answers that the user does not trust the folder.
        cancelId: 1,
      });
      return response === 0;
    },
    showMenu(workspace, actions) {
      Menu.buildFromTemplate([
        {
          label: t('workspaces.menu.trusted'),
          type: 'checkbox',
          checked: workspace.trusted,
          click: () => {
            actions.setTrusted(!workspace.trusted);
          },
        },
        { type: 'separator' },
        {
          label: t('workspaces.menu.remove'),
          click: () => {
            actions.remove();
          },
        },
      ]).popup({ window });
    },
  };
}
