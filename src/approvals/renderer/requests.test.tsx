import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import type {
  ApprovalAnswer,
  ApprovalRequest,
  QuestionAnswer,
  QuestionRequest,
} from '../../sessions/shared/events';
import { ApprovalBlock, QuestionBlock, Request } from './requests';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

const command: ApprovalRequest = {
  id: 'r1',
  action: 'command',
  title: 'Run the tests',
  reason: 'The build changed.',
  command: 'pnpm test',
  cwd: '/Users/me/web',
  canAllowForSession: true,
  denyByDefault: false,
  requestedAt: 0,
};

const settle = () => act(() => Promise.resolve());

describe('ApprovalBlock', () => {
  it('shows what the agent wants to do and answers it once, for the session or not at all', async () => {
    const onAnswer = vi.fn<(answer: ApprovalAnswer) => Promise<void>>(() => Promise.resolve());
    render(<ApprovalBlock request={command} onAnswer={onAnswer} />);
    const block = screen.getByRole('region', { name: 'Run this command?' });
    for (const text of ['Run the tests', 'The build changed.', 'pnpm test', '/Users/me/web']) {
      within(block).getByText(text);
    }
    const allow = within(block).getByRole('button', { name: 'Allow Once' });
    expect(allow.className).toContain('bg-ink');
    fireEvent.click(allow);
    await settle();
    fireEvent.click(within(block).getByRole('button', { name: 'Allow for This Session' }));
    await settle();
    fireEvent.click(within(block).getByRole('button', { name: 'Deny' }));
    await settle();
    expect(onAnswer.mock.calls).toEqual([
      [{ decision: 'allow-once' }],
      [{ decision: 'allow-for-session' }],
      [{ decision: 'deny' }],
    ]);
  });

  it('draws Deny as the default where the provider asks, and leaves out what the provider cannot remember', () => {
    render(
      <ApprovalBlock
        request={{ ...command, canAllowForSession: false, denyByDefault: true }}
        onAnswer={() => Promise.resolve()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Allow for This Session' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Deny' }).className).toContain('bg-ink');
    expect(screen.getByRole('button', { name: 'Allow Once' }).className).not.toContain('bg-ink');
  });

  it('shows an edit’s change and a plan', () => {
    render(
      <>
        <ApprovalBlock
          request={{
            id: 'r2',
            action: 'edit',
            paths: ['src/a.ts'],
            diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
            canAllowForSession: false,
            denyByDefault: false,
            requestedAt: 0,
          }}
        />
        <ApprovalBlock
          request={{
            id: 'r3',
            action: 'plan',
            plan: '1. **Read** the logs',
            canAllowForSession: false,
            denyByDefault: false,
            requestedAt: 0,
          }}
        />
      </>,
    );
    within(screen.getByRole('region', { name: 'Make these changes?' })).getByText('new');
    expect(screen.getByText('Read').tagName).toBe('STRONG');
  });

  it('says when an answer could not be sent', async () => {
    render(<ApprovalBlock request={command} onAnswer={() => Promise.reject(new Error('gone'))} />);
    fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
    await settle();
    screen.getByText('The answer couldn’t be sent.');
  });
});

const library: QuestionRequest = {
  id: 'q1',
  questions: [
    {
      id: 'library',
      header: 'Library',
      text: 'Which library should we use?',
      options: [{ label: 'zod', description: 'Schemas' }, { label: 'valibot' }],
      multiSelect: false,
      freeText: false,
      secret: false,
    },
  ],
  requestedAt: 0,
};

const checks: QuestionRequest = {
  id: 'q2',
  questions: [
    {
      id: 'checks',
      text: 'Which checks?',
      options: [{ label: 'lint' }, { label: 'tests' }, { label: 'types' }],
      multiSelect: true,
      freeText: true,
      secret: false,
    },
    {
      id: 'token',
      text: 'Your registry token?',
      options: [],
      multiSelect: false,
      freeText: true,
      secret: true,
    },
  ],
  requestedAt: 0,
};

describe('QuestionBlock', () => {
  it('answers a question of one choice with its button, and declines with Skip', async () => {
    const onAnswer = vi.fn<(answer: QuestionAnswer) => Promise<void>>(() => Promise.resolve());
    render(<QuestionBlock request={library} onAnswer={onAnswer} />);
    const block = screen.getByRole('region', { name: 'The agent asks' });
    within(block).getByText('Library');
    expect(within(block).queryByRole('button', { name: 'Answer' })).toBeNull();
    fireEvent.click(within(block).getByRole('button', { name: /^zod/ }));
    await settle();
    fireEvent.click(within(block).getByRole('button', { name: 'Skip' }));
    await settle();
    expect(onAnswer.mock.calls).toEqual([
      [{ decision: 'answer', answers: { library: { selected: ['zod'] } } }],
      [{ decision: 'decline' }],
    ]);
  });

  it('sends several choices and typed answers once every question has one, a secret masked', async () => {
    const onAnswer = vi.fn<(answer: QuestionAnswer) => Promise<void>>(() => Promise.resolve());
    render(<QuestionBlock request={checks} onAnswer={onAnswer} />);
    const answer = screen.getByRole('button', { name: 'Answer' });
    expect(answer).toHaveProperty('disabled', true);
    const lint = screen.getByRole('button', { name: 'lint' });
    fireEvent.click(lint);
    fireEvent.click(screen.getByRole('button', { name: 'types' }));
    fireEvent.click(screen.getByRole('button', { name: 'tests' }));
    fireEvent.click(screen.getByRole('button', { name: 'tests' }));
    expect(lint.getAttribute('aria-pressed')).toBe('true');
    fireEvent.change(screen.getByRole('textbox', { name: 'Which checks?' }), {
      target: { value: ' format ' },
    });
    expect(answer).toHaveProperty('disabled', true);
    const token = screen.getByLabelText('Your registry token?');
    expect(token.getAttribute('type')).toBe('password');
    fireEvent.change(token, { target: { value: 'secret-value' } });
    fireEvent.click(answer);
    await settle();
    expect(onAnswer.mock.calls).toEqual([
      [
        {
          decision: 'answer',
          answers: {
            checks: { selected: ['lint', 'types'], text: 'format' },
            token: { selected: [], text: 'secret-value' },
          },
        },
      ],
    ]);
  });
});

describe('the keyboard', () => {
  it('answers a focused approval with Return, ⌥Return and Escape, and leaves Return to a focused button', async () => {
    const onAnswer = vi.fn<(answer: ApprovalAnswer) => Promise<void>>(() => Promise.resolve());
    render(<ApprovalBlock request={command} onAnswer={onAnswer} focusKey={1} />);
    const block = screen.getByRole('region', { name: 'Run this command?' });
    expect(document.activeElement).toBe(block);
    for (const key of [{ key: 'Enter' }, { key: 'Enter', altKey: true }, { key: 'Escape' }]) {
      fireEvent.keyDown(block, key);
      await settle();
    }
    fireEvent.keyDown(within(block).getByRole('button', { name: /Deny/ }), { key: 'Enter' });
    await settle();
    expect(onAnswer.mock.calls).toEqual([
      [{ decision: 'allow-once' }],
      [{ decision: 'allow-for-session' }],
      [{ decision: 'deny' }],
    ]);
  });

  it('denies with Return where the provider wants Deny as the default, and allows nothing from one key', async () => {
    const onAnswer = vi.fn<(answer: ApprovalAnswer) => Promise<void>>(() => Promise.resolve());
    render(<ApprovalBlock request={{ ...command, denyByDefault: true }} onAnswer={onAnswer} />);
    const block = screen.getByRole('region', { name: 'Run this command?' });
    fireEvent.keyDown(block, { key: 'Enter', altKey: true });
    await settle();
    fireEvent.keyDown(block, { key: 'Enter' });
    await settle();
    expect(onAnswer.mock.calls).toEqual([[{ decision: 'deny' }]]);
  });

  it('sends a denial’s message where the provider passes it on, from Deny or Return in its field', async () => {
    const onAnswer = vi.fn<(answer: ApprovalAnswer) => Promise<void>>(() => Promise.resolve());
    const { rerender } = render(
      <ApprovalBlock request={{ ...command, denialMessage: true }} onAnswer={onAnswer} />,
    );
    const field = screen.getByRole('textbox', { name: 'Tell the agent what to do instead' });
    fireEvent.change(field, { target: { value: ' Use the staging database. ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /Deny/ }));
    await settle();
    expect(onAnswer.mock.calls).toEqual([
      [{ decision: 'deny', message: 'Use the staging database.' }],
      [{ decision: 'deny', message: 'Use the staging database.' }],
    ]);
    rerender(<ApprovalBlock request={command} onAnswer={onAnswer} />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('chooses a focused question’s choices by number, answers with Return and skips with Escape', async () => {
    const onAnswer = vi.fn<(answer: QuestionAnswer) => Promise<void>>(() => Promise.resolve());
    const { rerender } = render(<QuestionBlock request={library} onAnswer={onAnswer} />);
    fireEvent.keyDown(screen.getByRole('region', { name: 'The agent asks' }), { key: '2' });
    await settle();
    expect(onAnswer.mock.calls).toEqual([
      [{ decision: 'answer', answers: { library: { selected: ['valibot'] } } }],
    ]);
    onAnswer.mockClear();
    rerender(<QuestionBlock key="checks" request={checks} onAnswer={onAnswer} />);
    const block = screen.getByRole('region', { name: 'The agent asks' });
    fireEvent.keyDown(block, { key: '1' });
    fireEvent.keyDown(block, { key: '3' });
    expect(screen.getByRole('button', { name: /lint/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(screen.getByLabelText('Your registry token?'), { key: '7' });
    fireEvent.change(screen.getByLabelText('Your registry token?'), {
      target: { value: 'secret-value' },
    });
    fireEvent.keyDown(screen.getByLabelText('Your registry token?'), { key: 'Enter' });
    await settle();
    fireEvent.keyDown(block, { key: 'Escape' });
    await settle();
    expect(onAnswer.mock.calls).toEqual([
      [
        {
          decision: 'answer',
          answers: {
            checks: { selected: ['lint', 'types'] },
            token: { selected: [], text: 'secret-value' },
          },
        },
      ],
      [{ decision: 'decline' }],
    ]);
  });
});

describe('Request', () => {
  it('answers a waiting request through the session’s answering', async () => {
    const approval = vi.fn<(requestId: string, answer: ApprovalAnswer) => Promise<void>>(() =>
      Promise.resolve(),
    );
    render(
      <Request
        item={{ type: 'approval', request: command }}
        answering={{ approval, question: () => Promise.resolve() }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await settle();
    expect(approval.mock.calls).toEqual([['r1', { decision: 'deny' }]]);
  });

  it('collapses an answered approval to an entry that says what came of it, and opens to show it', () => {
    const { rerender } = render(
      <Request
        item={{
          type: 'approval',
          request: command,
          resolution: 'answered',
          answer: { decision: 'deny', message: 'Use the staging database.' },
        }}
      />,
    );
    expect(screen.queryByRole('region')).toBeNull();
    const line = screen.getByRole('button', { name: /Run this command\?/ });
    expect(line.textContent).toContain('Denied');
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('pnpm test')).toBeNull();
    fireEvent.click(line);
    expect(line.getAttribute('aria-expanded')).toBe('true');
    screen.getByText('pnpm test');
    screen.getByText('“Use the staging database.”');
    for (const [answer, word] of [
      [{ decision: 'allow-once' }, 'Allowed once'],
      [{ decision: 'allow-for-session' }, 'Allowed for this session'],
      [undefined, 'Answered'],
    ] as const) {
      rerender(
        <Request
          item={{
            type: 'approval',
            request: command,
            resolution: 'answered',
            ...(answer === undefined ? {} : { answer }),
          }}
        />,
      );
      expect(screen.getByRole('button', { name: /Run this command\?/ }).textContent).toContain(
        word,
      );
    }
    rerender(<Request item={{ type: 'approval', request: command, resolution: 'cancelled' }} />);
    screen.getByText('Withdrawn');
  });

  it('collapses an answered question, which opens to show the choices made and the text typed, a secret’s hidden', () => {
    const { rerender } = render(
      <Request
        item={{
          type: 'question',
          request: checks,
          resolution: 'answered',
          answer: {
            decision: 'answer',
            answers: {
              checks: { selected: ['lint', 'types'], text: 'format' },
              token: { selected: [] },
            },
          },
        }}
      />,
    );
    const line = screen.getByRole('button', { name: /Which checks\?/ });
    expect(line.textContent).toContain('Answered');
    fireEvent.click(line);
    expect(screen.getByText('lint').parentElement?.textContent).toBe('lintchosen');
    expect(screen.getByText('tests').parentElement?.textContent).toBe('tests');
    screen.getByText('format');
    screen.getByText('Hidden answer');
    rerender(
      <Request
        item={{
          type: 'question',
          request: library,
          resolution: 'answered',
          answer: { decision: 'decline' },
        }}
      />,
    );
    expect(screen.getByRole('button', { name: /Which library/ }).textContent).toContain('Skipped');
  });
});
