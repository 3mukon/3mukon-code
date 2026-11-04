// A terminal the main process runs for a window: its id, the folder it started in, and the name of the
// program it started with, the shell or a provider's sign-in command.
export interface TerminalInfo {
  id: string;
  cwd: string;
  program: string;
}

// The most a terminal is drawn with, so that a size the page sends cannot ask for more.
export const MAX_COLUMNS = 1_000;
export const MAX_ROWS = 500;

// What the window asks of the terminals' main-process side through the preload bridge. What a terminal
// prints and what the user types pass through it, and nothing else reads, keeps or logs them
// (ADR-0016).
export interface TerminalBridge {
  // Starts the user's login shell in a terminal in the folder, or in the home folder when it is null.
  open(cwd: string | null): Promise<TerminalInfo>;
  // Sends what the user typed or pasted to the terminal's program.
  write(id: string, data: string): Promise<void>;
  // Sets the terminal's size, in characters.
  resize(id: string, columns: number, rows: number): Promise<void>;
  // Calls the listener with what each of the window's terminals prints, and returns a function that
  // stops it.
  onOutput(listener: (id: string, data: string) => void): () => void;
  // Calls the listener when the program a terminal started with ends, with its exit code.
  onExit(listener: (id: string, code: number) => void): () => void;
  // Resolves with whether the terminal's panel may close: at once while the shell alone runs, and
  // otherwise once the user confirms that what runs ends with it.
  confirmClose(id: string): Promise<boolean>;
  // Ends the terminal and whatever runs in it.
  close(id: string): Promise<void>;
  // Opens a web link from a terminal in the browser.
  openLink(url: string): Promise<void>;
}
