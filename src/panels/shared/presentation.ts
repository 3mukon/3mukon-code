// The presentation contract between the main process and the window (ADR-0026, ADR-0027). Main takes
// the panel tools' requests, checks what an agent may present, gives each presentation its ID, one
// for each of a session's reuse keys, and keeps the notices of the user's closes for the agents. The
// window owns the layout: it alone decides where a presentation goes and whether a command applies,
// answers each command it is sent, and tells main of the user's closes and of the user's requests to
// see a presentation again. A presentation never takes the keyboard focus or the focused panel, so
// commands carry no focus request.

// What one of a presentation's panels shows, by handles main has checked before it sends them: a tab
// of the browser module, the preview of a computer target, a file by its absolute path, or an
// artifact main holds.
export type PresentedContent =
  | { kind: 'browser'; tabId: string }
  | { kind: 'computer'; targetId: string }
  | { kind: 'file'; path: string }
  | { kind: 'artifact'; artifactId: string };

// The image types an artifact may hold. SVG, which can carry scripts, is not one of them.
export const ARTIFACT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ArtifactImageType = (typeof ARTIFACT_IMAGE_TYPES)[number];

export type TableCell = string | number | boolean | null;

// A result an agent made to present, which main holds for its session: Markdown, an image in base64,
// or a table of rows under named columns. Its title names its panel.
export type Artifact =
  | { format: 'markdown'; title: string; text: string }
  | {
      format: 'image';
      title: string;
      mediaType: ArtifactImageType;
      data: string;
      width: number;
      height: number;
    }
  | { format: 'table'; title: string; columns: string[]; rows: TableCell[][] };

// An artifact's limits, which main enforces as an agent makes one and the window again as it draws it.
export const ARTIFACT_LIMITS = {
  // A title, in characters.
  titleLength: 120,
  // Markdown's text, in UTF-8.
  markdownBytes: 256 * 1024,
  // An image's base64 text, in bytes, as tool results' frames are measured, and its longest edge in
  // pixels.
  imageBase64Bytes: 8 * 1024 * 1024,
  imageEdge: 4096,
  tableRows: 1000,
  tableColumns: 32,
  // A table's columns and rows, as JSON in UTF-8.
  tableBytes: 2 * 1024 * 1024,
} as const;

// The side of its session's panel a presentation opens on.
export type PresentationSide = 'left' | 'right' | 'top' | 'bottom';

// Where a presentation goes: beside its session's panel, on the side given, or at that side of the
// panel area while the session has no panel open, with its panels, when it has several, side by side
// in a row or stacked in a column.
export interface Placement {
  side: PresentationSide;
  direction: 'row' | 'column';
}

export const DEFAULT_PLACEMENT: Placement = { side: 'right', direction: 'row' };

// Where a panel lies in the panel area: its box, in fractions of the area's width and height from its
// top left corner.
export interface PanelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// One of a session's own panels, of which a session may have several, and where it lies.
export interface SessionPanel {
  owner: string;
  box: PanelBox;
}

export const PRESENTATION_LIMITS = {
  // The panels one presentation shows; a comparison is one presentation with several.
  items: 4,
  // A presentation's title, in characters.
  titleLength: 120,
  // An ID, a handle or a path, in characters.
  idLength: 4096,
} as const;

// How long the window holds a command that arrives while the user drags, before refusing it as busy.
// Main waits longer than this for each answer.
export const PRESENTATION_HOLD_MS = 10_000;

// What every command carries. The IDs are main's: the command's own, used once; the epoch of the page
// it is meant for; the session the presentation comes from, by the app's id; and the presentation's,
// which stays the same across pages. Main sends at most one command for a presentation at a time, and
// the window answers a repeat of a command ID with the answer it gave it, as long as it keeps it.
interface CommandBasis {
  commandId: string;
  epoch: string;
  owner: string;
  presentationId: string;
  // The presentation's version as its agent last saw it, in a tool result, a notice or the panel
  // list, or 0 for one it has never seen. The window refuses the command where the presentation has
  // another version, so that nothing an agent sends from an outdated picture of it applies, such as an
  // item meant for one panel landing in another; the refusal gives the agent the presentation's
  // current state to try again from. A present for a presentation the page does not have, as after a
  // reload, applies, the page counting on from its version.
  version: number;
}

// What main asks of the window. What a presentation's panels show is its agent's, and which of them
// are open is the user's, who closes them, and present's, which opens them. The agent gets each of
// its presentations' latest state after every change and can list them, and each command carries the
// version it last saw, so the window never guesses at either. A presentation has one panel for each of its items,
// in order, and shows each thing once.
// - present shows its items, every panel open: in place of the presentation's panels where any is
//   open, or else where its placement says. It alone changes how many items a presentation has.
// - update changes what the presentation's panels show, one item for each panel in order, and the
//   title. It opens and closes none, so a panel the user closed stays closed whatever it shows, and
//   as it places no panel it never waits for a drag to end.
// - arrange places the presentation's open panels again.
// - close closes all its panels.
export type PresentationCommand =
  | (CommandBasis & {
      kind: 'present';
      title: string;
      items: PresentedContent[];
      placement: Placement;
    })
  | (CommandBasis & { kind: 'update'; title: string; items: PresentedContent[] })
  | (CommandBasis & { kind: 'arrange'; placement: Placement })
  | (CommandBasis & { kind: 'close' });

// Main withdraws a command the window has not applied yet, such as one held during a drag. The window
// answers it as cancelled, or with the answer it already gave.
export interface PresentationCancel {
  kind: 'cancel';
  commandId: string;
  epoch: string;
}

export type PresentationHostMessage = PresentationCommand | PresentationCancel;

// Why the window refused a command.
export type PresentationRefusal =
  // Meant for an earlier page, which a reload or a closed window took with it.
  | 'stale-epoch'
  // A command ID already answered, or waiting for the drop, came again with other content.
  | 'command-conflict'
  // Malformed, with items that repeat, or past the limits, which main checks first.
  | 'invalid-command'
  // The presentation belongs to another session.
  | 'wrong-owner'
  // A command other than a present, for a presentation the page does not have: it never showed it, or
  // forgot it, with no panel open, as one of those that changed longest ago.
  | 'presentation-unknown'
  // The command's version is not the presentation's: the presentation changed after its agent last saw
  // it. The refusal's state is where it stands now, for the agent to try again from.
  | 'presentation-changed'
  // An update that does not give one item for each of the presentation's panels, whose number only a
  // present changes.
  | 'item-count-mismatch'
  // A file panel the command would close, or show anything else in, holds unsaved changes.
  | 'unsaved-changes'
  // The user went on dragging for longer than the window holds a command.
  | 'busy';

// A presentation as the window has it.
export interface PresentationState {
  presentationId: string;
  owner: string;
  // Goes up by one with every change to the presentation: each command the window applies to it and
  // each change the window reports.
  version: number;
  // Where each of its panels lies, in the order of its items, or null where it is closed: a panel is
  // open exactly when it has a box.
  boxes: (PanelBox | null)[];
}

// The window's answer to a command, one for each command it is sent, and the same again for a command
// ID it has answered.
export type PresentationAnswer =
  | {
      kind: 'applied';
      commandId: string;
      epoch: string;
      state: PresentationState;
    }
  | {
      kind: 'refused';
      commandId: string;
      // The page's own epoch, which a stale command learns this way.
      epoch: string;
      presentationId: string;
      code: PresentationRefusal;
      // The presentation as the window has it now, if it has it, which a refusal for its version
      // gives the agent to try again from.
      state: PresentationState | null;
    }
  | { kind: 'cancelled'; commandId: string; epoch: string };

// What happened in the window that main must hear of, which main answers with commands where it
// answers it at all.
// - changed: a presentation's latest state, after any change that no command for it made, as the user
//   closing, moving or resizing its panels, the layout around them changing, or another presentation
//   of its session taking its place. The agent needs only where things stand, not how they came to be.
// - show: the user asked to see one of the session's presentations again, from its activity, or a tab
//   or application the session uses that no presentation shows, from the line above its composer,
//   which main answers with a present command.
export type PresentationReport =
  | { kind: 'changed'; epoch: string; state: PresentationState }
  | { kind: 'show'; epoch: string; owner: string; presentationId: string }
  | { kind: 'show'; epoch: string; owner: string; content: UsedContent };

// What the line above a session's composer names, which the user can ask to see: a tab or application
// the session uses.
export type UsedContent = Extract<PresentedContent, { kind: 'browser' | 'computer' }>;

// What the window has, sent as a page starts, which is how main learns the page's epoch, and again
// whenever the sessions' own panels change; every change to a presentation comes in an answer or a
// report instead. Main keeps what it learns for listing, never as a layout of its own. A presentation
// that was open before a new page's first snapshot, and that it does not list, went with the reload
// or the closed window: the user did not close it.
export interface PresentationSnapshot {
  kind: 'snapshot';
  epoch: string;
  // The sessions' own panels that are open.
  sessionPanels: SessionPanel[];
  // The presentations the page has, open or not.
  presentations: PresentationState[];
}

export type PresentationRendererMessage =
  PresentationAnswer | PresentationReport | PresentationSnapshot;

// What the window's presentations ask of the main process through the preload bridge.
export interface PresentationBridge {
  // Main's commands and cancels, in the order sent; the function returned stops listening.
  onMessage(listener: (message: PresentationHostMessage) => void): () => void;
  // The window's answers, reports and snapshots, in order.
  send(message: PresentationRendererMessage): void;
  // An artifact main holds, or null once it no longer does.
  artifact(artifactId: string): Promise<Artifact | null>;
}

// Whether any of a presentation's panels is open.
export function isOpen(state: PresentationState): boolean {
  return state.boxes.some((box) => box !== null);
}

// Whether two items show the same.
export function sameContent(a: PresentedContent, b: PresentedContent): boolean {
  switch (a.kind) {
    case 'browser':
      return b.kind === 'browser' && b.tabId === a.tabId;
    case 'computer':
      return b.kind === 'computer' && b.targetId === a.targetId;
    case 'file':
      return b.kind === 'file' && b.path === a.path;
    case 'artifact':
      return b.kind === 'artifact' && b.artifactId === a.artifactId;
  }
}

// Whether a command is well formed, with distinct items, and within the limits.
export function commandWithinLimits(command: PresentationCommand): boolean {
  const basis =
    [command.commandId, command.epoch, command.owner, command.presentationId].every(validId) &&
    validCount(command.version);
  switch (command.kind) {
    case 'present':
      return (
        basis &&
        validTitle(command.title) &&
        validItems(command.items) &&
        validPlacement(command.placement)
      );
    case 'update':
      return basis && validTitle(command.title) && validItems(command.items);
    case 'arrange':
      return basis && validPlacement(command.placement);
    case 'close':
      return basis;
  }
}

// Whether an artifact is well formed and within the limits.
export function artifactWithinLimits(artifact: Artifact): boolean {
  if (!within(artifact.title, ARTIFACT_LIMITS.titleLength)) return false;
  switch (artifact.format) {
    case 'markdown':
      return utf8Length(artifact.text) <= ARTIFACT_LIMITS.markdownBytes;
    case 'image':
      return (
        (ARTIFACT_IMAGE_TYPES as readonly string[]).includes(artifact.mediaType) &&
        [artifact.width, artifact.height].every(
          (edge) => Number.isInteger(edge) && edge >= 1 && edge <= ARTIFACT_LIMITS.imageEdge,
        ) &&
        artifact.data.length <= ARTIFACT_LIMITS.imageBase64Bytes &&
        isBase64(artifact.data)
      );
    case 'table':
      return (
        artifact.columns.length >= 1 &&
        artifact.columns.length <= ARTIFACT_LIMITS.tableColumns &&
        artifact.rows.length <= ARTIFACT_LIMITS.tableRows &&
        artifact.rows.every((row) => row.length === artifact.columns.length) &&
        utf8Length(JSON.stringify([artifact.columns, artifact.rows])) <= ARTIFACT_LIMITS.tableBytes
      );
  }
}

function validId(id: string): boolean {
  return id.length >= 1 && id.length <= PRESENTATION_LIMITS.idLength;
}

function validCount(count: number): boolean {
  return Number.isSafeInteger(count) && count >= 0;
}

function validTitle(title: string): boolean {
  return within(title, PRESENTATION_LIMITS.titleLength);
}

function within(text: string, length: number): boolean {
  return text.trim() !== '' && text.length <= length;
}

function validItems(items: readonly PresentedContent[]): boolean {
  return (
    items.length >= 1 &&
    items.length <= PRESENTATION_LIMITS.items &&
    items.every((item) => validId(handleOf(item))) &&
    items.every((item) => item.kind !== 'file' || item.path.startsWith('/')) &&
    items.every((item, place) => items.findIndex((other) => sameContent(other, item)) === place)
  );
}

function handleOf(item: PresentedContent): string {
  switch (item.kind) {
    case 'browser':
      return item.tabId;
    case 'computer':
      return item.targetId;
    case 'file':
      return item.path;
    case 'artifact':
      return item.artifactId;
  }
}

function validPlacement(placement: Placement): boolean {
  return (
    ['left', 'right', 'top', 'bottom'].includes(placement.side) &&
    ['row', 'column'].includes(placement.direction)
  );
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

// Whether text is base64, padded to whole groups of four characters.
function isBase64(data: string): boolean {
  return data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data);
}
