import type { FolderChoices, RememberedChoice } from './sessions';

// Whether the path is a day folder: a folder named for its day's date, YYYY-MM-DD, in the day root,
// where session pages open while no workspace has been added.
export function isDayFolder(dayRoot: string, path: string): boolean {
  return (
    path.startsWith(`${dayRoot}/`) && /^\d{4}-\d{2}-\d{2}$/.test(path.slice(dayRoot.length + 1))
  );
}

// The settings sessions in the folder last used: in a day folder, those all the day folders share.
export function choiceIn(choices: FolderChoices, folder: string): RememberedChoice | undefined {
  return isDayFolder(choices.dayRoot, folder) ? choices.dayFolders : choices.folders[folder];
}

// The choices with the folder's settings, or the day folders' for a day folder, replaced.
export function withChoice(
  choices: FolderChoices,
  folder: string,
  choice: RememberedChoice,
): FolderChoices {
  return isDayFolder(choices.dayRoot, folder)
    ? { ...choices, dayFolders: choice }
    : { ...choices, folders: { ...choices.folders, [folder]: choice } };
}
