import type { Language } from '../../i18n/shared/language';
import type { Bounds, Outcome, Preview } from '../../sessions/shared/automation';

export type ComputerCommand = 'reveal' | 'take-over' | 'hand-back';

// Read-only preview of an exact window already shown for this session. The frame does not
// create a receipt for computer input. A busy result lets the panel keep the previous frame.
export interface ComputerBridge {
  preview(owner: string, presentation: string, target: string): Promise<Outcome<Preview>>;
  command(
    owner: string,
    presentation: string,
    target: string,
    command: ComputerCommand,
  ): Promise<Outcome<null>>;
}

export type ControlState = 'acting' | 'user' | 'secure-input' | 'came-forward' | 'stopping';
export type ControlCommand = 'stop' | 'hand-back';

export interface ControlWindowButton {
  command: ControlCommand;
  label: string;
  bounds: Bounds;
  enabled: boolean;
}

export interface ControlWindowSnapshot {
  revision: number;
  control: {
    state: ControlState;
    session: string;
    application: string;
    stopShortcut: boolean;
    language: Language;
    displayId: number;
    bounds: Bounds;
  } | null;
}

// The hidden page draws the control. The helper places that frame and receives the clicks.
export interface ControlWindowBridge {
  snapshot(): Promise<ControlWindowSnapshot>;
  onState(listener: (state: ControlWindowSnapshot) => void): () => void;
  ready(revision: number, buttons: readonly ControlWindowButton[]): Promise<void>;
}
