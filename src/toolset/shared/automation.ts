import type { ApprovalAnswer, MessageImage } from '../../sessions/shared/events';
import type {
  AutomationCallRecord,
  AutomationCapabilities,
  AutomationEvent,
  AutomationSnapshot,
  Envelope,
  Frame,
  Outcome,
  SetupSnapshot,
} from '../../sessions/shared/automation';

// App UI only. The MCP executor receives none of these user-action methods.
export interface AutomationBridge {
  snapshot(sessionId: string): Promise<Envelope<AutomationSnapshot>>;
  subscribe(sessionId: string, listener: (event: Envelope<AutomationEvent>) => void): () => void;
  callRecord(sessionId: string, callId: string): Promise<Outcome<AutomationCallRecord>>;
  // Fetch only for displayed calls. A retained record can outlive its image bytes.
  callFrames(sessionId: string, callId: string): Promise<Outcome<readonly Frame[]>>;
  // Cache by this stable ID in the UI; the session must still have a retained fact naming it.
  icon(sessionId: string, iconId: string): Promise<Outcome<MessageImage>>;
  capabilities(sessionId: string): Promise<AutomationCapabilities>;
  answer(sessionId: string, requestId: string, answer: ApprovalAnswer): Promise<Outcome<null>>;
  stop(sessionId: string): Promise<Outcome<null>>;
  endOperation(sessionId: string, id: string): Promise<Outcome<null>>;
  endGrant(sessionId: string, id: string): Promise<Outcome<null>>;
}
export type SetupAction =
  | {
      kind: 'connect-browser';
      browser: 'chrome';
      profileId: string;
    }
  | {
      kind: 'disconnect-browser';
      browser: 'chrome';
      profileId: string;
    }
  | {
      kind: 'open-permission';
      permission: 'accessibility' | 'screen-recording' | 'input-monitoring';
    }
  | { kind: 'clear-app-sign-ins' | 'restart-helper' };
export interface UserSetupBridge {
  snapshot(): Promise<SetupSnapshot>;
  subscribe(listener: (snapshot: SetupSnapshot) => void): () => void;
  act(action: SetupAction): Promise<Outcome<null>>;
}
