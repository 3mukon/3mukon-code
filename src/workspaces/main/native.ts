import { dialog, type BrowserWindow } from 'electron';
import type { Translate } from '../../i18n/main/i18n';
import type { Prompts } from '../../ui/shared/prompts';
import type { WorkspacesUi } from './workspaces';

// The workspaces' questions and menu for the window that asked: the folder picker as macOS's own sheet
// on the window, and the trust question and a workspace's menu at the pointer as the window draws them,
// in the app's own look (the prompts).
export function windowWorkspacesUi(
  window: BrowserWindow,
  prompts: Prompts,
  t: Translate,
): WorkspacesUi {
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
      const answer = await prompts.ask({
        message: t('workspaces.trust.message', { name }),
        // The providers go by the names they have everywhere else in the app.
        detail: t('workspaces.trust.detail', {
          path,
          claudeCode: t('providers.claude-code'),
          codex: t('providers.codex'),
          grokBuild: t('providers.grok-build'),
        }),
        answers: [
          { id: 'trust', label: t('workspaces.trust.trust') },
          { id: 'distrust', label: t('workspaces.trust.distrust') },
        ],
        defaultId: 'trust',
        // Escape answers that the user does not trust the folder.
        cancelId: 'distrust',
      });
      return answer === 'trust';
    },
    async showMenu(workspace, actions) {
      const chosen = await prompts.menu([
        { id: 'open-in-terminal', label: t('workspaces.menu.openInTerminal') },
        { separator: true },
        { id: 'trusted', label: t('workspaces.menu.trusted'), checked: workspace.trusted },
        { separator: true },
        { id: 'remove', label: t('workspaces.menu.remove') },
      ]);
      if (chosen === 'open-in-terminal') return 'open-in-terminal';
      if (chosen === 'trusted') actions.setTrusted(!workspace.trusted);
      else if (chosen === 'remove') actions.remove();
      return null;
    },
    async showFolderMenu() {
      const chosen = await prompts.menu([
        { id: 'open-in-terminal', label: t('workspaces.menu.openInTerminal') },
      ]);
      return chosen === 'open-in-terminal' ? 'open-in-terminal' : null;
    },
  };
}
