import { z } from 'zod';
import type { Question, QuestionAnswer } from '../../sessions/shared/events';

// The question tool, which lets a provider without a question tool of its own ask the user.
export const ASK_USER = 'ask_user';

export const askUserDescription = [
  'Ask the user one to four questions and wait for the answers. Use it when you need the user to choose, confirm or tell you something before you can go on, instead of ending your turn with a question.',
  'Each question may offer up to eight options, for one choice or for several, and the user can always type an answer of their own, so add no "Other" option.',
  'The call waits, with no time limit, until the user answers or declines, the turn is interrupted or the session closes. It returns status "answered" with one entry per question, in the order asked, holding the labels chosen and any text typed; or status "cancelled" with no answers. After a cancellation, assume no answer: stop what depended on it and follow what the user says next.',
].join('\n');

const text = (maximum: number) => z.string().trim().min(1).max(maximum);

const option = z
  .object({
    label: text(200).describe('The choice as the user sees it, unique within its question.'),
    description: z
      .string()
      .max(1000)
      .optional()
      .describe('What choosing it means, when the label alone does not say.'),
  })
  .strict();

const question = z
  .object({
    question: text(2000).describe('The question, complete in itself.'),
    header: text(40).optional().describe('A label of a few words, such as "Library".'),
    options: z
      .array(option)
      .max(8)
      .optional()
      .describe('Up to eight choices; leave it out for a question answered in words only.'),
    multiSelect: z
      .boolean()
      .optional()
      .describe('Whether the user may choose more than one option; false when left out.'),
  })
  .strict()
  .refine(
    (entry) =>
      new Set(entry.options?.map((choice) => choice.label)).size === (entry.options?.length ?? 0),
    'The options of a question need labels of their own.',
  );

export const askUserInput = {
  questions: z
    .array(question)
    .min(1)
    .max(4)
    .describe('One to four questions, which the user sees together.'),
};

export const askUserOutput = {
  status: z
    .enum(['answered', 'cancelled'])
    .describe(
      'answered once the user has answered; cancelled when the call ended without answers.',
    ),
  answers: z
    .array(
      z.object({
        question: z.string().describe('The question as it was asked.'),
        selected: z.array(z.string()).describe('The labels of the options the user chose.'),
        text: z.string().optional().describe('What the user typed, if anything.'),
      }),
    )
    .describe('One entry per question, in the order asked; none when cancelled.'),
};

export type AskUserInput = z.infer<z.ZodObject<typeof askUserInput>>;
export type AskUserResult = z.infer<z.ZodObject<typeof askUserOutput>>;

// The questions as the session model shows them. Every question takes typed text, and none is secret.
export function toQuestions(input: AskUserInput): Question[] {
  return input.questions.map((entry, index) => ({
    id: `q${String(index)}`,
    ...(entry.header === undefined ? {} : { header: entry.header }),
    text: entry.question,
    options: (entry.options ?? []).map((choice) => ({
      label: choice.label,
      ...(choice.description === undefined || choice.description === ''
        ? {}
        : { description: choice.description }),
    })),
    multiSelect: entry.multiSelect ?? false,
    freeText: true,
    secret: false,
  }));
}

// The tool's result for the user's answer, in the order the questions were asked.
export function toResult(questions: Question[], answer: QuestionAnswer): AskUserResult {
  if (answer.decision === 'decline') return { status: 'cancelled', answers: [] };
  return {
    status: 'answered',
    answers: questions.map((entry) => {
      const given = answer.answers[entry.id];
      return {
        question: entry.text,
        selected: given?.selected ?? [],
        ...(given?.text === undefined || given.text === '' ? {} : { text: given.text }),
      };
    }),
  };
}
