// How long a new terminal's output rests before the terminal shows, so that what its program prints in
// several writes at once, such as zsh's mark for a partial line followed by its prompt, shows whole.
export const SETTLE_MS = 40;

// How long a new terminal waits for its program's output before it shows anyway.
export const FIRST_DRAW_LIMIT_MS = 1_000;

// When a new terminal shows: once its emulator has taken in its program's first output and no more has
// followed for a moment, so that the terminal never shows an empty line with a cursor, or part of a
// prompt, just before its prompt; at once when its program ends; and at the latest a second after its
// emulator opened, for a program that prints nothing or never rests. It goes by when output comes,
// never by what it says (ADR-0016).
export class FirstDraw {
  private rest: ReturnType<typeof setTimeout> | undefined;
  private limit: ReturnType<typeof setTimeout> | undefined;
  private done = false;

  constructor(private readonly show: () => void) {}

  // The emulator has opened and waits for output.
  open(): void {
    if (this.done || this.limit !== undefined) return;
    this.limit = setTimeout(() => {
      this.now();
    }, FIRST_DRAW_LIMIT_MS);
  }

  // The emulator has taken in output: the terminal shows once no more follows for a moment.
  output(): void {
    if (this.done) return;
    clearTimeout(this.rest);
    this.rest = setTimeout(() => {
      this.now();
    }, SETTLE_MS);
  }

  // Shows the terminal at once, as when its program has ended.
  now(): void {
    if (this.done) return;
    this.stop();
    this.show();
  }

  // Leaves the terminal as it is from now on, as it goes.
  dispose(): void {
    this.stop();
  }

  private stop(): void {
    this.done = true;
    clearTimeout(this.rest);
    clearTimeout(this.limit);
  }
}
