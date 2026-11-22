import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ApprovalAnswer,
  ApprovalRequest,
  Question,
  QuestionAnswer,
  QuestionRequest,
} from '../../sessions/shared/events';
import type { RequestItem } from '../../sessions/shared/session-state';
import { DiffView } from '../../sessions/renderer/diff-view';
import { Markdown } from '../../sessions/renderer/markdown';
import { Entry } from '../../sessions/renderer/tool-call';
import { Check, CircleQuestionMark, ShieldCheck } from '../../ui/renderer/icons';
import { StatusDot } from '../../ui/renderer/status-dot';

// Answers a session's approvals and questions by their ids.
export interface Answering {
  approval: (requestId: string, answer: ApprovalAnswer) => Promise<void>;
  question: (requestId: string, answer: QuestionAnswer) => Promise<void>;
}

interface RequestProps {
  item: RequestItem;
  answering?: Answering;
  // Changes when the request should take the keyboard focus, as the waiting indicator and ⇧⌘A ask.
  focusKey?: number;
}

// An approval or a question where it stands in a session's activity: while it waits, a block that
// answers it; once answered or withdrawn, an entry like a tool call's, which says what came of it and
// opens to show the request and the answer.
export function Request({ item, answering, focusKey }: RequestProps) {
  const focus = focusKey === undefined ? {} : { focusKey };
  if (item.type === 'approval') {
    if (item.resolution !== undefined) return <AnsweredApproval item={item} />;
    return (
      <ApprovalBlock
        request={item.request}
        {...focus}
        {...(answering === undefined
          ? {}
          : { onAnswer: (answer: ApprovalAnswer) => answering.approval(item.request.id, answer) })}
      />
    );
  }
  if (item.resolution !== undefined) return <AnsweredQuestion item={item} />;
  return (
    <QuestionBlock
      request={item.request}
      {...focus}
      {...(answering === undefined
        ? {}
        : { onAnswer: (answer: QuestionAnswer) => answering.question(item.request.id, answer) })}
    />
  );
}

interface ApprovalBlockProps {
  request: ApprovalRequest;
  // Sends the answer; left out where the session cannot be answered from here.
  onAnswer?: (answer: ApprovalAnswer) => Promise<void>;
  focusKey?: number;
}

// A provider's approval waiting in the activity: what the agent wants to do, in the window's
// language, with the request's details under it, answered as AnswerBlock answers.
export function ApprovalBlock({ request, onAnswer, focusKey }: ApprovalBlockProps) {
  const { t } = useTranslation();
  const heading = approvalHeading(request, t);
  return (
    <AnswerBlock
      heading={heading}
      details={<ApprovalDetails request={request} heading={heading} />}
      canAllowForSession={request.canAllowForSession}
      denyByDefault={request.denyByDefault}
      denialMessage={request.denialMessage === true}
      {...(onAnswer === undefined ? {} : { onAnswer })}
      {...(focusKey === undefined ? {} : { focusKey })}
    />
  );
}

interface AnswerBlockProps {
  // What the agent wants to do, as a question.
  heading: string;
  // What more the block says under the heading.
  details: ReactNode;
  // Whether Allow for This Session is offered.
  canAllowForSession: boolean;
  // Whether Deny is the default answer, with no one-key approval.
  denyByDefault: boolean;
  // Whether a denial can carry the user's message to the agent.
  denialMessage: boolean;
  // Sends the answer; left out where the session cannot be answered from here.
  onAnswer?: (answer: ApprovalAnswer) => Promise<void>;
  focusKey?: number;
}

// An approval waiting in the activity, as the reference's question block, whether the provider asks
// or the app does for an operation of its tools: the heading and the details under it, then Allow
// Once, Allow for This Session where it can be remembered, and Deny. The default answer is drawn in
// ink, Deny when it is asked to be. Where a denial's message reaches the agent, a field under the
// buttons takes one, which Deny sends.
//
// While the block has the focus, as macOS's dialogs: Return gives the default answer, ⌥Return allows
// for the session, unless it wants no approval from one key, and Escape denies. In the message's
// field, Return denies with the message and Escape leaves the field. A focused button keeps its own
// Return and Space.
export function AnswerBlock({
  heading,
  details,
  canAllowForSession,
  denyByDefault,
  denialMessage,
  onAnswer,
  focusKey,
}: AnswerBlockProps) {
  const { t } = useTranslation();
  const { sending, failed, send } = useSending(onAnswer);
  const block = useFocusOn(focusKey);
  const [message, setMessage] = useState('');
  const deny = (): ApprovalAnswer => {
    const typed = message.trim();
    return typed === '' || !denialMessage
      ? { decision: 'deny' }
      : { decision: 'deny', message: typed };
  };
  const forSession = canAllowForSession && !denyByDefault;
  const choices: { answer: () => ApprovalAnswer; key: string; label: string; keys?: string }[] = [
    {
      answer: () => ({ decision: 'allow-once' }),
      key: 'allow-once',
      label: t('approvals.allowOnce'),
      ...(denyByDefault ? {} : { keys: '↩' }),
    },
    ...(canAllowForSession
      ? [
          {
            answer: (): ApprovalAnswer => ({ decision: 'allow-for-session' }),
            key: 'allow-for-session',
            label: t('approvals.allowForSession'),
            ...(forSession ? { keys: '⌥↩' } : {}),
          },
        ]
      : []),
    {
      answer: deny,
      key: 'deny',
      label: t('approvals.deny'),
      keys: denyByDefault ? '↩ ⎋' : '⎋',
    },
  ];
  const primary = denyByDefault ? 'deny' : 'allow-once';
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (onAnswer === undefined || sending || event.metaKey || event.ctrlKey) return;
    const inField = event.target instanceof HTMLInputElement;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (inField) block.current?.focus();
      else send(deny());
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (inField) {
      event.preventDefault();
      send(deny());
    } else if (event.altKey) {
      if (!forSession) return;
      event.preventDefault();
      send({ decision: 'allow-for-session' });
    } else if (event.target === event.currentTarget) {
      event.preventDefault();
      send(denyByDefault ? deny() : { decision: 'allow-once' });
    }
  };
  return (
    <Block label={heading} ref={block} onKeyDown={onKeyDown}>
      <Heading text={heading} />
      {details}
      {onAnswer !== undefined && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {choices.map(({ answer, key, label, keys }) => (
            <Choice
              key={key}
              label={label}
              {...(keys === undefined ? {} : { keys })}
              primary={key === primary}
              disabled={sending}
              onClick={() => {
                send(answer());
              }}
            />
          ))}
        </div>
      )}
      {onAnswer !== undefined && denialMessage && (
        <input
          type="text"
          aria-label={t('approvals.denialMessage')}
          placeholder={t('approvals.denialMessage')}
          value={message}
          autoComplete="off"
          disabled={sending}
          onChange={(event) => {
            setMessage(event.target.value);
          }}
          className="mt-1.5 w-full rounded-md border border-dashed border-line bg-transparent px-2 py-0.5 text-[12px] text-ink outline-none placeholder:text-placeholder focus:border-solid focus:border-accent"
        />
      )}
      {failed && <Failed />}
    </Block>
  );
}

interface QuestionBlockProps {
  request: QuestionRequest;
  onAnswer?: (answer: QuestionAnswer) => Promise<void>;
  focusKey?: number;
}

// A question, or several, waiting in the activity, with the reference's choice buttons and a field for
// an answer of the user's own where the agent takes one, masked when it asks for a secret. A single
// question of one choice and no typed answer is answered by its button; otherwise the user chooses,
// types, and sends with Answer once every question has an answer. Skip declines.
//
// While the block has the focus: 1 to 9 choose the question's choices by number, those of the question
// the focus is in, or else of the first, which shows the numbers; Return answers and Escape skips. In
// a field, digits are typed, Return answers, and Escape leaves the field.
export function QuestionBlock({ request, onAnswer, focusKey }: QuestionBlockProps) {
  const { t } = useTranslation();
  const { sending, failed, send } = useSending(onAnswer);
  const block = useFocusOn(focusKey);
  const [chosen, setChosen] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [typed, setTyped] = useState<Readonly<Record<string, string>>>({});
  const only = request.questions.length === 1 ? request.questions[0] : undefined;
  const byButton = only !== undefined && !only.multiSelect && !only.freeText;
  const answered = (question: Question) =>
    (chosen[question.id]?.length ?? 0) > 0 || (typed[question.id] ?? '').trim() !== '';
  const complete = request.questions.every(answered);
  const choose = (question: Question, label: string) => {
    if (byButton) {
      send({ decision: 'answer', answers: { [question.id]: { selected: [label] } } });
      return;
    }
    setChosen((current) => {
      const now = current[question.id] ?? [];
      const has = now.includes(label);
      const next = question.multiSelect
        ? has
          ? now.filter((each) => each !== label)
          : [...now, label]
        : has
          ? []
          : [label];
      return { ...current, [question.id]: next };
    });
  };
  const answers = () =>
    Object.fromEntries(
      request.questions.map((question) => {
        const text = (typed[question.id] ?? '').trim();
        return [
          question.id,
          { selected: [...(chosen[question.id] ?? [])], ...(text === '' ? {} : { text }) },
        ];
      }),
    );
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (onAnswer === undefined || sending || event.metaKey || event.ctrlKey || event.altKey) return;
    const inField = event.target instanceof HTMLInputElement;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (inField) block.current?.focus();
      else send({ decision: 'decline' });
      return;
    }
    if (event.key === 'Enter') {
      // A focused choice or button keeps its own Return.
      if (event.target instanceof HTMLButtonElement || byButton || !complete) return;
      event.preventDefault();
      send({ decision: 'answer', answers: answers() });
      return;
    }
    if (inField || !/^[1-9]$/.test(event.key)) return;
    const within = (event.target as Element)
      .closest('[data-question]')
      ?.getAttribute('data-question');
    const question =
      request.questions.find((each) => each.id === within) ??
      request.questions.find((each) => each.options.length > 0);
    const option = question?.options[Number(event.key) - 1];
    if (question === undefined || option === undefined) return;
    event.preventDefault();
    choose(question, option.label);
  };
  return (
    <Block label={t('approvals.asks')} ref={block} onKeyDown={onKeyDown}>
      {request.questions.map((question, index) => (
        <div key={question.id} data-question={question.id} className={index === 0 ? '' : 'mt-3'}>
          <Heading
            text={question.text}
            {...(question.header === undefined ? {} : { header: question.header })}
          />
          {question.options.length > 0 && (
            <div role="group" aria-label={question.text} className="mt-1.5 flex flex-wrap gap-1.5">
              {question.options.map((option, number) => {
                const selected = chosen[question.id]?.includes(option.label) === true;
                return (
                  <button
                    key={option.label}
                    type="button"
                    {...(byButton ? {} : { 'aria-pressed': selected })}
                    {...(option.description === undefined ? {} : { title: option.description })}
                    {...(number < 9 ? { 'aria-keyshortcuts': String(number + 1) } : {})}
                    disabled={sending || onAnswer === undefined}
                    onClick={() => {
                      choose(question, option.label);
                    }}
                    className={`max-w-full rounded-md border px-2.5 py-0.5 text-left text-[12px] disabled:opacity-50 ${selected ? 'border-ink bg-ink text-frame' : 'border-line text-ink hover:bg-hover'}`}
                  >
                    {number < 9 && (
                      <span
                        aria-hidden="true"
                        className="mr-1.5 hidden opacity-60 group-focus-within/request:inline"
                      >
                        {number + 1}
                      </span>
                    )}
                    {option.label}
                    {option.description !== undefined && (
                      <span
                        className={`block text-[11px] ${selected ? 'opacity-75' : 'text-faint'}`}
                      >
                        {option.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {question.freeText && (
            <input
              type={question.secret ? 'password' : 'text'}
              aria-label={question.text}
              placeholder={t(
                question.options.length > 0 ? 'approvals.otherAnswer' : 'approvals.yourAnswer',
              )}
              value={typed[question.id] ?? ''}
              autoComplete="off"
              spellCheck={false}
              disabled={sending || onAnswer === undefined}
              onChange={(event) => {
                setTyped((current) => ({ ...current, [question.id]: event.target.value }));
              }}
              className="mt-1.5 w-full rounded-md border border-dashed border-line bg-transparent px-2 py-0.5 text-[12px] text-ink outline-none placeholder:text-placeholder focus:border-solid focus:border-accent"
            />
          )}
        </div>
      ))}
      {onAnswer !== undefined && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {!byButton && (
            <Choice
              label={t('approvals.answer')}
              keys="↩"
              primary
              disabled={sending || !complete}
              onClick={() => {
                send({ decision: 'answer', answers: answers() });
              }}
            />
          )}
          <Choice
            label={t('approvals.skip')}
            keys="⎋"
            primary={false}
            disabled={sending}
            onClick={() => {
              send({ decision: 'decline' });
            }}
          />
        </div>
      )}
      {failed && <Failed />}
    </Block>
  );
}

// An answered or withdrawn approval: what the agent wanted to do and what the user answered, which
// opens to show the request, and the message a denial sent.
function AnsweredApproval({ item }: { item: Extract<RequestItem, { type: 'approval' }> }) {
  const { t } = useTranslation();
  const heading = approvalHeading(item.request, t);
  const note =
    item.resolution === 'cancelled'
      ? t('approvals.outcome.withdrawn')
      : item.answer === undefined
        ? t('approvals.outcome.answered')
        : t(`approvals.outcome.${item.answer.decision}`);
  return (
    <Entry
      icon={ShieldCheck}
      kind={t('approvals.kind.approval')}
      status="completed"
      title={heading}
      bright={false}
      note={note}
      body={
        <div className="min-w-0">
          <ApprovalDetails request={item.request} heading={heading} />
          {item.answer?.decision === 'deny' && item.answer.message !== undefined && (
            <p className="mt-1 text-ink">
              {t('approvals.message', { message: item.answer.message })}
            </p>
          )}
        </div>
      }
    />
  );
}

// An answered or withdrawn question: its text and what came of it, which opens to show the choices the
// user made and what they typed, a secret's text hidden, under each question where it asked several.
function AnsweredQuestion({ item }: { item: Extract<RequestItem, { type: 'question' }> }) {
  const { t } = useTranslation();
  const { answer } = item;
  const note =
    item.resolution === 'cancelled'
      ? t('approvals.outcome.withdrawn')
      : answer === undefined
        ? t('approvals.outcome.answered')
        : t(`approvals.outcome.${answer.decision}`);
  const given = answer?.decision === 'answer' ? answer.answers : undefined;
  return (
    <Entry
      icon={CircleQuestionMark}
      kind={t('approvals.kind.question')}
      status="completed"
      title={item.request.questions[0]?.text ?? t('approvals.asks')}
      bright={false}
      note={note}
      body={
        <div className="flex min-w-0 flex-col gap-2">
          {item.request.questions.map((question) => {
            const mine = given?.[question.id];
            return (
              <div key={question.id} className="min-w-0">
                {item.request.questions.length > 1 && (
                  <p className="text-ink">
                    {question.header !== undefined && (
                      <span className="mr-2 text-faint">{question.header}</span>
                    )}
                    {question.text}
                  </p>
                )}
                {question.options.length > 0 && (
                  <ul>
                    {question.options.map((option) => {
                      const picked = mine?.selected.includes(option.label) === true;
                      return (
                        <li
                          key={option.label}
                          className={`flex items-baseline gap-1.5 ${picked ? 'text-ink' : 'text-faint'}`}
                        >
                          <span className="w-3.5 shrink-0">
                            {picked && <Check className="size-3" />}
                          </span>
                          <span className="min-w-0">{option.label}</span>
                          {picked && <span className="sr-only">{t('approvals.chosen')}</span>}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {mine?.text !== undefined && <p className="text-ink">{mine.text}</p>}
                {mine !== undefined && mine.text === undefined && question.secret && (
                  <p className="text-faint">{t('approvals.hidden')}</p>
                )}
              </div>
            );
          })}
        </div>
      }
    />
  );
}

// What an approval asks for, under its heading: the provider's own wording and the agent's reason,
// then the command and its folder, the files and the change, or the plan.
function ApprovalDetails({ request, heading }: { request: ApprovalRequest; heading: string }) {
  return (
    <>
      {request.title !== undefined && request.title !== heading && (
        <p className="mt-0.5 text-muted">{request.title}</p>
      )}
      {request.reason !== undefined && <p className="mt-0.5 text-muted">{request.reason}</p>}
      {request.command !== undefined && (
        <pre className="mt-1.5 font-mono break-all whitespace-pre-wrap text-ink">
          {request.command}
        </pre>
      )}
      {request.cwd !== undefined && <p className="text-faint">{request.cwd}</p>}
      {request.paths !== undefined && request.diff === undefined && (
        <ul className="mt-1.5 text-ink">
          {request.paths.map((path) => (
            <li key={path} className="break-all">
              {path}
            </li>
          ))}
        </ul>
      )}
      {request.diff !== undefined && (
        <div className="mt-1.5">
          <DiffView diff={request.diff} />
        </div>
      )}
      {request.plan !== undefined && (
        <div className="mt-1.5 max-h-80 overflow-auto font-sans text-ink">
          <Markdown text={request.plan} />
        </div>
      )}
    </>
  );
}

// What an approval asks, in the window's language.
function approvalHeading(
  request: ApprovalRequest,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  return t(`approvals.heading.${request.action}`, {
    tool: request.toolName ?? request.title ?? '',
  });
}

// Sends an answer at most once at a time, and says whether the last one failed. A sent answer waits
// for the provider to resolve the request, which turns the block into an entry.
function useSending<Answer>(onAnswer: ((answer: Answer) => Promise<void>) | undefined) {
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const send = (answer: Answer) => {
    if (onAnswer === undefined || sending) return;
    setSending(true);
    setFailed(false);
    onAnswer(answer).then(
      () => {
        setSending(false);
      },
      () => {
        setSending(false);
        setFailed(true);
      },
    );
  };
  return { sending, failed, send };
}

// Takes the keyboard focus whenever the key changes, the first time included.
function useFocusOn(focusKey: number | undefined) {
  const element = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focusKey !== undefined) element.current?.focus();
  }, [focusKey]);
  return element;
}

// A request's block lies on the window's paper, grain and all, under a dashed line, so that only what
// it holds, such as a diff, is paper set apart.
function Block({
  label,
  ref,
  onKeyDown,
  children,
}: {
  label: string;
  ref: Ref<HTMLElement>;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  children: ReactNode;
}) {
  return (
    <section
      ref={ref}
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="group/request my-3 rounded-md border border-dashed border-line px-3 py-2"
    >
      {children}
    </section>
  );
}

function Heading({ text, header }: { text: string; header?: string }) {
  return (
    <p className="flex min-w-0 items-baseline gap-2 text-ink">
      <span className="-translate-y-0.5">
        <StatusDot status="waiting" />
      </span>
      <span className="min-w-0">
        {header !== undefined && <span className="mr-2 text-faint">{header}</span>}
        {text}
      </span>
    </p>
  );
}

// A button of a block, with the keys that also press it, shown faintly while the block has the focus.
function Choice({
  label,
  keys,
  primary,
  disabled,
  onClick,
}: {
  label: string;
  keys?: string;
  primary: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md border px-2.5 py-0.5 text-[12px] disabled:opacity-50 ${primary ? 'border-ink bg-ink text-frame hover:opacity-90' : 'border-line text-ink hover:bg-hover'}`}
    >
      {label}
      {keys !== undefined && (
        <span
          aria-hidden="true"
          className="ml-1.5 hidden opacity-60 group-focus-within/request:inline"
        >
          {keys}
        </span>
      )}
    </button>
  );
}

function Failed() {
  const { t } = useTranslation();
  return (
    <p role="status" className="mt-1 text-del">
      {t('approvals.failed')}
    </p>
  );
}
