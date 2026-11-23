import { useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from '../../ui/renderer/icons';
import type { MessageImage, MessageRole } from '../shared/events';
import { Images } from './images';
import { Markdown } from './markdown';
import { TimelineActionsContext } from './timeline-actions';

// How long Copy shows that it copied.
const COPIED_MS = 1_500;

interface MessageProps {
  role: MessageRole;
  text: string;
  images?: MessageImage[];
  // The provider's name, which VoiceOver reads before each of the agent's messages.
  agent: string;
  // For a message in the user's place that another session sent, as a parent sends its child its
  // task (ADR-0036): that session's title, which names the message's sender in place of the user.
  from?: string;
}

// The line above thinking gives way, near its end, to MD or TXT and Copy while they show: its mask cuts
// out a notch as wide as they are (--notch), which has no size until the thinking is hovered or holds
// the focus, 6px from the line's right end.
const notched =
  '[mask-image:linear-gradient(#000,#000),linear-gradient(#000,#000)] [mask-repeat:no-repeat] [mask-composite:exclude] [mask-size:100%_100%,0_0] group-hover:[mask-size:100%_100%,var(--notch)_2px] group-focus-within:[mask-size:100%_100%,var(--notch)_2px] [mask-position:0_0,right_6px_top_0]';

// One message, as the reference's activity shows it: the user's at the right with its images above its
// text and the agent's at the left with its images below, each in a bubble filled with the darker paper
// and drawn without an outline, at most 88% of the width and named for VoiceOver by its sender; and the
// agent's thinking quieter, under a dashed line instead of in a bubble. A message shows as Markdown or as
// plain text, the agent's and its thinking as Markdown at first and the user's as plain text. MD or TXT,
// which switches, and Copy, which puts its text on the clipboard, show while the pointer or the focus is
// on the message, near its top end: on a bubble, as a tab of the bubble's paper over its top edge; above
// thinking, over its line, which gives way beneath them, as the context in use sits in the divider above
// the composer. Out of the flow, they never widen a short bubble.
export function Message({ role, text, images = [], agent, from }: MessageProps) {
  const { t } = useTranslation();
  const [markdown, setMarkdown] = useState(role !== 'user');
  const body =
    text === '' ? null : markdown ? (
      // In a block of its own, so that its first and last paragraphs keep no outer margin.
      <div className="min-w-0">
        <Markdown text={text} />
      </div>
    ) : (
      <p className="break-words whitespace-pre-wrap">{text}</p>
    );
  const tools = (place: string) =>
    text === '' ? null : (
      <div
        className={`absolute -top-2 flex h-4 w-(--notch) items-center justify-center gap-0.5 not-italic opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 ${place}`}
      >
        <Tools text={text} markdown={markdown} onSwitch={setMarkdown} />
      </div>
    );

  if (role === 'thinking') {
    return (
      <div className="group relative my-3 min-w-0 pt-2 text-faint italic [--notch:3.5rem]">
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-line ${notched}`}
        />
        {tools('right-1.5')}
        {body}
      </div>
    );
  }
  const user = role === 'user';
  const shown = images.length === 0 ? null : <Images images={images} />;
  const sender =
    from !== undefined
      ? t('sessions.page.fromSession', { session: from })
      : user
        ? t('sessions.page.fromUser')
        : t('sessions.page.fromAgent', { agent });
  return (
    <div
      className={`my-3 flex min-w-0 first:mt-0 ${
        from === undefined
          ? user
            ? 'justify-end'
            : 'justify-start'
          : `flex-col gap-0.5 ${user ? 'items-end' : 'items-start'}`
      }`}
    >
      <span className="sr-only">{sender}</span>
      {/* Another session's message in the user's place says whose it is, faintly, above it. */}
      {from !== undefined && (
        <span aria-hidden="true" className="max-w-[88%] truncate text-[11px] text-faint">
          {t('sessions.page.sentBy', { session: from })}
        </span>
      )}
      <div className="group paper-bubble relative flex max-w-[88%] min-w-0 flex-col gap-1.5 rounded-lg px-2.5 py-1.5 text-ink [--notch:3.5rem]">
        {/* The tools 6px from the bubble's right end; or, for the agent's bubble, 6px from its left end
            where the bubble is narrower than they are, so that they reach out over the empty side. */}
        {tools(
          `paper-bubble rounded-md ${user ? 'right-1.5' : 'left-[max(6px,calc(100%_-_var(--notch)_-_6px))]'}`,
        )}
        {user && shown}
        {body}
        {!user && shown}
      </div>
    </div>
  );
}

// MD or TXT, which switches how the message shows, and Copy.
function Tools({
  text,
  markdown,
  onSwitch,
}: {
  text: string;
  markdown: boolean;
  onSwitch: (markdown: boolean) => void;
}) {
  const { t } = useTranslation();
  const actions = useContext(TimelineActionsContext);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => {
      setCopied(false);
    }, COPIED_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [copied]);
  const switchLabel = t(markdown ? 'sessions.page.showPlain' : 'sessions.page.showMarkdown');
  const copyLabel = t(copied ? 'sessions.page.copied' : 'sessions.page.copy');
  return (
    <>
      <button
        type="button"
        aria-label={switchLabel}
        title={switchLabel}
        onClick={() => {
          onSwitch(!markdown);
        }}
        className="w-7 rounded font-mono text-[10px] leading-4 text-faint hover:bg-hover hover:text-ink"
      >
        {markdown ? 'MD' : 'TXT'}
      </button>
      <button
        type="button"
        aria-label={copyLabel}
        title={copyLabel}
        onClick={() => {
          actions.copyText(text);
          setCopied(true);
        }}
        className="grid size-4 place-items-center rounded text-faint hover:bg-hover hover:text-ink"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </>
  );
}
