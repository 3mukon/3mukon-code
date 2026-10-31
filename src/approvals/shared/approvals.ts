import type { ApprovalAnswer, QuestionAnswer } from '../../sessions/shared/events';

// What the window asks of the approvals through the preload bridge: answering an approval or a
// question that a session waits on, by the app's id for the session and the request's id.
export interface ApprovalsBridge {
  answerApproval(sessionId: string, requestId: string, answer: ApprovalAnswer): Promise<void>;
  answerQuestion(sessionId: string, requestId: string, answer: QuestionAnswer): Promise<void>;
}
