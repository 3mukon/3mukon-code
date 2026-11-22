// This listener runs before website scripts in an isolated world. The port signals that the
// app should take the drag. The embedding page never receives its files or their names.
function shieldFileDrag(report: () => void): void {
  const handOff = (event: DragEvent) => {
    if (!event.isTrusted || !event.dataTransfer?.types.includes('Files')) return;
    event.stopImmediatePropagation();
    event.preventDefault();
    event.dataTransfer.dropEffect = 'none';
    if (event.type !== 'drop') report();
  };
  for (const type of ['dragenter', 'dragover', 'drop'] as const)
    window.addEventListener(type, handOff, true);
}

export const FILE_DRAG_SCRIPT = '(' + shieldFileDrag.toString() + ')';
