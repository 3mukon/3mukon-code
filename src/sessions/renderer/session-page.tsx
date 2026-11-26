import { startTransition, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { SelectOption } from '../../ui/renderer/select';
import type {
  MessageImage,
  PermissionMode,
  ProviderId,
  ReasoningEffort,
  SandboxLevel,
} from '../shared/events';
import { effortInUse, startingEffort } from '../shared/efforts';
import type { RememberedChoice, SessionsBridge, SessionSummary } from '../shared/sessions';
import { Attachments, useAttachments } from './attachments';
import { SessionSettings, type Setting } from './session-settings';
import {
  Timeline,
  type RenderRequest,
  type RenderToolCall,
  type RenderToolExtra,
} from './timeline';
import { TimelineActionsContext, timelineActions } from './timeline-actions';
import { rememberChoice, useOffers, useProviders, useRemembered } from './use-offers';
import { useSession } from './use-session';

// What a page starts its session with, or resumes it with when it is not running. A null gateway is
// the provider's own configuration and a null model the provider's default; a null effort is the
// page's own starting effort for the model before the session starts, and afterwards the model's
// default.
interface Choice {
  provider: ProviderId;
  gateway: string | null;
  model: string | null;
  effort: ReasoningEffort | null;
  mode: PermissionMode;
  sandbox: SandboxLevel;
}

const firstChoice: Choice = {
  provider: 'claude-code',
  gateway: null,
  model: null,
  effort: null,
  mode: 'auto',
  sandbox: 'workspace-write',
};

// The providers in the provider menu's order, until the app's own list comes.
const listedProviders: readonly ProviderId[] = ['claude-code', 'codex', 'grok-build'];

const modes: PermissionMode[] = ['auto', 'yolo'];
const sandboxes: SandboxLevel[] = ['read-only', 'workspace-write', 'full-access'];

// How many more of the activity's last items the page renders at a time when many come at once, as a
// history does, until they fill its view; those before them follow in a render that leaves the
// window free meanwhile, so that the end shows at once.
const FIRST_ITEMS = 24;

// What the page shows of the providers' accounts, which whoever composes the page gives it.
export interface AccountViews {
  // Whether the provider is known not to be signed in, which its choice says.
  signedOut(provider: ProviderId): boolean;
  // Whether the provider is known to be signed in, which a new page prefers.
  signedIn(provider: ProviderId): boolean;
  // Whether the provider is known not to be installed: neither the user's CLI nor the app's copy runs,
  // which its choice says and its sign-in mends (ADR-0039).
  notInstalled(provider: ProviderId): boolean;
  // Whether the app is downloading its copy of the provider, whose progress the sign-in's place shows.
  downloading(provider: ProviderId): boolean;
  // Says that the provider is not signed in, or not installed, and offers its sign-in, or a
  // download's progress, at the top of the activity.
  signIn(provider: ProviderId): ReactNode;
  // The provider's notice of its usage limits, beside the context in use, or null.
  notice(provider: ProviderId): ReactNode;
}

interface SessionPageProps {
  bridge: SessionsBridge;
  // The folder the session works in, or will work in.
  folder: string;
  // The session the page shows once it has started; null while it has not.
  sessionId: string | null;
  // What the Sessions list knows of the session, such as its provider, once it is listed.
  summary?: SessionSummary;
  // Called with the app's id for the session once the page has started it.
  onStarted: (id: string) => void;
  // Shows the session's approvals and questions in its activity, with what answers them.
  renderRequest?: RenderRequest;
  // Shows, under a tool call in its activity, what the app knows of it, such as a presentation.
  renderToolExtra?: RenderToolExtra;
  // Shows, in place of a tool call's own entry, what the app knows it did, such as a browser's action.
  renderToolCall?: RenderToolCall;
  // Lines above the composer's divider, such as what the session's tools use, with Show and Stop.
  aboveComposer?: ReactNode;
  // What waits on the user apart from the provider's own requests, such as the approval the app asks
  // for an operation of its tools, at the activity's end.
  hostRequests?: ReactNode;
  // The providers' sign-ins and usage limits.
  accounts?: AccountViews;
  // For a child session, its parent's title, which names the sender of its first message
  // (ADR-0036).
  parentTitle?: string;
}

// A session page. Before its first message it chooses the provider, gateway, model, reasoning effort,
// permission mode and sandbox level, and nothing runs; the first message starts the session, and from
// then on the page is the session, showing its activity, with everything but the provider still
// switchable. The model starts as the provider's default, under its own name, and the effort as the
// page's starting effort for it; until the provider's models come, the page says it is loading them,
// and a session started before they come keeps the provider's own defaults. Until the user changes
// one, the settings are those the folder's sessions last used, but for the permission mode, and a model
// or effort no longer offered gives way to the default, and the provider prefers one the user is signed
// in to; a session's settings, as it starts, switches
// and resumes, are remembered for its folder. A session that is not running, from an earlier run or
// whose provider stopped, shows its history and starts nothing: its settings, but for the provider,
// are those it last had, its permission mode included, until the user changes them, and the next
// message resumes it with them. When many items come at once, as a history does, the page renders the
// last of them first, as many as fill its view, and the rest after, so that the end shows at once. Choosing yolo asks the user to confirm; a running session's sandbox
// level switches at once. The composer sends with Return and starts a new line with Shift-Return, with
// the images pasted into it or dropped on it, during a turn too, when the message goes to the running
// turn as the provider takes it; Stop ends the running turn.
export function SessionPage({
  bridge,
  folder,
  sessionId,
  summary,
  onStarted,
  renderRequest,
  renderToolExtra,
  renderToolCall,
  aboveComposer,
  hostRequests,
  accounts,
  parentTitle,
}: SessionPageProps) {
  const { t } = useTranslation();
  const state = useSession(bridge, sessionId);
  // The user's choice on this page, before the session starts or while it is not running, once they
  // have made one.
  const [chosen, setChosen] = useState<Choice | null>(null);
  // The provider a new page started with, kept once the user types, so that a sign-in learnt later
  // no longer changes it.
  const [kept, setKept] = useState<ProviderId | null>(null);
  const remembered = useRemembered(bridge, folder);
  const [draft, setDraft] = useState('');
  const attachments = useAttachments();
  const actions = useMemo(() => timelineActions(bridge), [bridge]);
  // The first message, with its images and the settings the session starts with, while the session
  // starts, and a message to a session that is not running while it resumes.
  const [starting, setStarting] = useState<{
    text: string;
    images: MessageImage[];
    settings: Choice;
  } | null>(null);
  const [resuming, setResuming] = useState<{ text: string; images: MessageImage[] } | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  const [resumeFailed, setResumeFailed] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const activity = useRef<HTMLDivElement>(null);
  // Whether the activity keeps its end in view as it grows; scrolling up stops that.
  const following = useRef(true);

  // A session that is not running, which shows its history and resumes with the next message.
  const closed = state?.closed === true;
  // Whether the settings are the page's to choose, as they are until the session starts and while it
  // is not running; otherwise they are the running session's, and each change switches it.
  const choosing = sessionId === null || closed;
  // What a new page starts with: the provider the folder's sessions last used, unless the
  // app knows it is signed out while another is signed in; with none, the first signed-in provider in
  // the provider menu's order; else Claude Code. Until the user picks a provider or types, a sign-in
  // the app learns later changes it.
  const offeredProviders = useProviders(bridge);
  const signedIn = (offeredProviders ?? listedProviders).filter(
    (id) => accounts?.signedIn(id) === true,
  );
  const automatic =
    remembered !== undefined &&
    !(
      (accounts?.signedOut(remembered.provider) === true ||
        accounts?.notInstalled(remembered.provider) === true) &&
      signedIn.length > 0
    )
      ? remembered.provider
      : (signedIn[0] ?? firstChoice.provider);
  const startsWith = kept ?? automatic;
  const provider =
    summary?.provider ??
    chosen?.provider ??
    starting?.settings.provider ??
    (sessionId === null ? startsWith : (remembered?.provider ?? firstChoice.provider));
  // The session's own settings: those it runs with, or those it last had.
  const own: Choice = {
    provider,
    gateway: state?.gateway ?? null,
    model: state?.model ?? null,
    effort: state?.effort ?? null,
    mode: state?.mode ?? 'auto',
    sandbox: state?.sandbox ?? 'workspace-write',
  };
  // A provider other than the remembered one starts with its own defaults, in the folder's sandbox.
  const unchanged =
    sessionId !== null
      ? own
      : remembered?.provider === startsWith
        ? { ...remembered, mode: 'auto' as const }
        : {
            ...firstChoice,
            provider: startsWith,
            sandbox: remembered?.sandbox ?? firstChoice.sandbox,
          };
  // Until a session the page has started gives its state, the settings it started with.
  const settings = choosing
    ? (chosen ?? unchanged)
    : state === null && starting !== null
      ? starting.settings
      : own;
  // A page before its first message asks for its folder's models as the provider's settings are now;
  // a session's page, which shows the model the session last ran, takes those found without a folder.
  const opening = sessionId === null;
  const offers = useOffers(bridge, provider, settings.gateway, opening ? folder : null, opening);
  // A running session's own list once it reports one, else the provider's; missing while it loads.
  const models = (choosing ? undefined : state?.models) ?? offers.models;
  // The model the provider uses when the session chooses none, under its own name, and the model in
  // use with its efforts. While the page chooses, a model the provider no longer offers, as one
  // remembered or last used may be, gives way to the default.
  const defaultModel = models?.find((entry) => entry.default === true);
  const chosenModel =
    choosing && models?.some((entry) => entry.id === settings.model) === false
      ? null
      : settings.model;
  const model =
    chosenModel === null ? defaultModel : models?.find((entry) => entry.id === chosenModel);
  const efforts = model?.efforts ?? [];
  // A choice of the default model itself shows as the default.
  const modelValue = chosenModel === defaultModel?.id ? '' : (chosenModel ?? '');
  // The effort without a choice: before the session starts the starting effort for the model, and
  // for a session without one the model's own default where the provider names it, or else the
  // starting effort, which the host sets for a running session whose model takes an effort
  // (`effortToSet`), so that an effort shows as a level of the model's whatever the provider says
  // of its default. While the page chooses, an effort the model does not take gives way to the
  // effort without a choice.
  const unchosenEffort =
    sessionId === null
      ? startingEffort(model)
      : (effortInUse(model, null) ?? startingEffort(model));
  const chosenEffort =
    choosing && model !== undefined && !efforts.includes(settings.effort ?? '')
      ? null
      : settings.effort;
  const effort = chosenEffort ?? unchosenEffort;
  // The message on its way while the session starts or resumes.
  const pending = (state === null ? starting : null) ?? (closed ? resuming : null);

  // The first of the activity's items rendered, and how many there were when that was chosen: when
  // many come at once, the last of them first.
  const count = state?.timeline.length ?? 0;
  const [rendered, setRendered] = useState({ from: 0, count: 0 });
  if (count !== rendered.count) {
    setRendered({
      from:
        count - rendered.count > FIRST_ITEMS ? count - FIRST_ITEMS : Math.min(rendered.from, count),
      count,
    });
  }

  // Before the window paints, more of the last items while those rendered leave the view room;
  // then the rest, in a render the window stays free during.
  useLayoutEffect(() => {
    if (rendered.from === 0) return;
    const [area, content] = [scroller.current, activity.current];
    const renderFrom = (from: (current: number) => number) => {
      setRendered((current) => ({ ...current, from: from(current.from) }));
    };
    if (area !== null && content !== null && content.offsetHeight < area.clientHeight) {
      renderFrom((current) => Math.max(0, current - FIRST_ITEMS));
      return;
    }
    const rest = setTimeout(() => {
      startTransition(() => {
        renderFrom(() => 0);
      });
    });
    return () => {
      clearTimeout(rest);
    };
  }, [rendered.from]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && following.current) element.scrollTop = element.scrollHeight;
  });

  // The end stays in view too as the activity or its area changes size after a render, as the
  // history's images load or the composer grows.
  useLayoutEffect(() => {
    const [area, content] = [scroller.current, activity.current];
    if (area === null || content === null) return;
    const observer = new ResizeObserver(() => {
      if (following.current) area.scrollTop = area.scrollHeight;
    });
    observer.observe(area);
    observer.observe(content);
    return () => {
      observer.disconnect();
    };
  }, []);

  const send = () => {
    const text = draft.trim();
    const { images } = attachments;
    if ((text === '' && images.length === 0) || pending !== null) return;
    setDraft('');
    attachments.clear();
    setStartFailed(false);
    setResumeFailed(false);
    // A message that could not go comes back to the composer, with its images.
    const restore = () => {
      setDraft(text);
      attachments.restore(images);
    };
    if (sessionId === null) {
      const started = { ...settings, model: chosenModel, effort };
      setStarting({ text, images, settings: started });
      bridge.start({ ...started, cwd: folder, message: text, images }).then(
        (id) => {
          const { provider: chosenProvider, gateway, model: startModel, sandbox } = started;
          rememberChoice(bridge, folder, {
            provider: chosenProvider,
            gateway,
            model: startModel,
            effort,
            sandbox,
          });
          onStarted(id);
        },
        (error: unknown) => {
          report(error);
          setStarting(null);
          setStartFailed(true);
          restore();
        },
      );
      return;
    }
    if (closed) {
      setResuming({ text, images });
      const { mode, gateway, sandbox } = settings;
      const resumed = { mode, gateway, model: chosenModel, effort: chosenEffort, sandbox };
      bridge.resume(sessionId, { ...resumed, message: text, images }).then(
        () => {
          setResuming(null);
          setChosen(null);
          rememberChoice(bridge, folder, {
            provider,
            gateway,
            model: chosenModel,
            effort: chosenEffort,
            sandbox,
          });
        },
        (error: unknown) => {
          report(error);
          setResuming(null);
          setResumeFailed(true);
          restore();
        },
      );
      return;
    }
    bridge.send(sessionId, text, images).catch((error: unknown) => {
      report(error);
      restore();
    });
  };

  // A change of the page's choice, from what it shows.
  const change = (next: Partial<Choice>) => {
    setChosen((current) => ({ ...(current ?? settings), ...next }));
  };
  // Remembers a running session's settings for its folder once a switch has taken.
  const switched = (next: Partial<RememberedChoice>) => () => {
    const { gateway, model: inUse, effort: level, sandbox } = settings;
    rememberChoice(bridge, folder, {
      provider,
      gateway,
      model: inUse,
      effort: level,
      sandbox,
      ...next,
    });
  };
  // A choice before the session starts or while it is not running, or a switch while it runs.
  const switchTo = {
    provider: (value: string) => {
      change({ provider: value as ProviderId, gateway: null, model: null, effort: null });
    },
    gateway: (value: string) => {
      const gateway = value === '' ? null : value;
      if (choosing) change({ gateway, model: null, effort: null });
      else bridge.setGateway(sessionId, gateway).then(switched({ gateway }), report);
    },
    model: (value: string) => {
      const next = value === '' ? null : value;
      if (choosing) change({ model: next, effort: null });
      else bridge.setModel(sessionId, next).then(switched({ model: next }), report);
    },
    effort: (value: string) => {
      const level = value === '' ? null : value;
      if (choosing) change({ effort: level });
      else bridge.setEffort(sessionId, level).then(switched({ effort: level }), report);
    },
    mode: (value: string) => {
      const mode = value as PermissionMode;
      if (!choosing) {
        bridge.setMode(sessionId, mode).catch(report);
      } else if (mode === 'yolo') {
        bridge.confirmYolo().then((confirmed) => {
          if (confirmed) change({ mode });
        }, report);
      } else {
        change({ mode });
      }
    },
    sandbox: (value: string) => {
      const sandbox = value as SandboxLevel;
      if (choosing) change({ sandbox });
      else bridge.setSandbox(sessionId, sandbox).then(switched({ sandbox }), report);
    },
  };

  const providerName = t(`providers.${provider}`);
  const placeholder = t('sessions.page.message');
  const withChosen = (
    options: SelectOption[],
    value: string | null,
    label = (chosen: string) => chosen,
  ): SelectOption[] =>
    value === null || options.some((option) => option.value === value)
      ? options
      : [...options, { value, label: label(value) }];
  const choosers: Setting[] = [
    sessionId === null
      ? {
          label: t('sessions.page.provider'),
          summary: true,
          value: provider,
          // The chosen provider alone until the app's providers come.
          options: (offers.providers ?? [provider]).map((id) => ({
            value: id,
            label:
              accounts?.notInstalled(id) === true
                ? t('sessions.page.notInstalled', { provider: t(`providers.${id}`) })
                : accounts?.signedOut(id) === true
                  ? t('sessions.page.notSignedIn', { provider: t(`providers.${id}`) })
                  : t(`providers.${id}`),
          })),
          onChange: switchTo.provider,
        }
      : { label: t('sessions.page.provider'), summary: true, text: providerName },
    ...(offers.gateways.length > 0 || settings.gateway !== null
      ? [
          {
            label: t('sessions.page.gateway'),
            // Named in the compact settings only once one is chosen.
            summary: settings.gateway !== null,
            value: settings.gateway ?? '',
            options: withChosen(
              [
                { value: '', label: t('sessions.page.noGateway') },
                ...offers.gateways.map((name) => ({ value: name, label: name })),
              ],
              settings.gateway,
            ),
            onChange: switchTo.gateway,
          },
        ]
      : []),
    models === undefined
      ? { label: t('sessions.page.model'), summary: true, text: t('sessions.page.loadingModels') }
      : {
          label: t('sessions.page.model'),
          summary: true,
          value: modelValue,
          options: withChosen(
            withDefault(
              models.map((entry) => ({
                value: entry === defaultModel ? '' : entry.id,
                label: entry.label,
              })),
              t('sessions.page.defaultModel'),
            ),
            modelValue === '' ? null : modelValue,
          ),
          onChange: switchTo.model,
        },
    ...(efforts.length > 0 || effort !== null
      ? [
          {
            label: t('sessions.page.effort'),
            summary: true,
            value: effort ?? '',
            // The model's levels alone: an effort always shows as one of them, never as a default.
            options: withChosen(
              efforts.map((level) => ({ value: level, label: effortLabel(level) })),
              effort,
              effortLabel,
            ),
            onChange: switchTo.effort,
          },
        ]
      : []),
    {
      label: t('sessions.page.mode'),
      summary: true,
      value: settings.mode,
      options: modes.map((mode) => ({ value: mode, label: t(`sessions.mode.${mode}`) })),
      onChange: switchTo.mode,
    },
    {
      label: t('sessions.page.sandbox'),
      summary: true,
      value: settings.sandbox,
      options: sandboxes.map((level) => ({ value: level, label: t(`sessions.sandbox.${level}`) })),
      onChange: switchTo.sandbox,
    },
  ];

  const notice = accounts?.notice(provider) ?? null;

  return (
    <TimelineActionsContext value={actions}>
      <div className="grid h-full min-h-0 grid-cols-1 grid-rows-[1fr_auto]">
        {/* Positioned, so that text for VoiceOver alone, taken out of the flow, stays inside the scroll
          area instead of lengthening the window's page. */}
        <section
          ref={scroller}
          aria-label={t('sessions.page.activity')}
          onScroll={(event) => {
            const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
            following.current = scrollHeight - scrollTop - clientHeight < 32;
          }}
          className="relative min-h-0 overflow-y-auto px-5 pt-2 pb-5 font-mono text-[12.5px]/[1.75] text-muted"
        >
          <div ref={activity}>
            {(accounts?.signedOut(provider) === true ||
              accounts?.notInstalled(provider) === true ||
              accounts?.downloading(provider) === true) &&
              accounts.signIn(provider)}
            {/* Said only once the history has taken a while, so that one read quickly, or ahead,
                shows at once in its place. */}
            {closed && state.loadingHistory && (
              <p className="my-3 animate-appear text-faint">{t('sessions.page.loadingHistory')}</p>
            )}
            {closed && state.historyFailed && (
              <p className="my-3 text-del">{t('sessions.page.historyFailed')}</p>
            )}
            <Timeline
              state={state}
              from={rendered.from}
              agent={providerName}
              {...(parentTitle === undefined ? {} : { firstFrom: parentTitle })}
              {...(pending === null ? {} : { pending })}
              {...(renderRequest === undefined ? {} : { renderRequest })}
              {...(renderToolExtra === undefined ? {} : { renderToolExtra })}
              {...(renderToolCall === undefined ? {} : { renderToolCall })}
              {...(hostRequests === undefined ? {} : { hostRequests })}
            />
            {startFailed && <p className="my-3 text-del">{t('sessions.page.startFailed')}</p>}
            {resumeFailed && <p className="my-3 text-del">{t('sessions.page.resumeFailed')}</p>}
          </div>
        </section>
        {/* The composer, on which images can be dropped, marked while they are dragged over it. */}
        <div
          {...attachments.dropZone}
          className={`mx-5 mb-3 rounded-md ${attachments.dropping ? 'outline-2 outline-offset-2 outline-accent outline-dashed' : ''}`}
        >
          {aboveComposer}
          {/* The divider above the composer, with the provider's notice of its usage limits and the
              context in use near its end. */}
          <div className="flex h-4 items-center gap-2">
            <div className="h-px min-w-0 flex-1 bg-line" />
            {notice}
            {state?.context !== undefined && <ContextUsage {...state.context} />}
            {(state?.context !== undefined || notice !== null) && (
              <div className="h-px w-3 shrink-0 bg-line" />
            )}
          </div>
          {attachments.attached.length > 0 && (
            <Attachments attached={attachments.attached} onRemove={attachments.remove} />
          )}
          {attachments.notice !== null && (
            <p role="status" className="mt-1 text-[11px] text-del">
              {attachments.notice}
            </p>
          )}
          <div className="mt-1 flex items-end gap-2">
            <textarea
              aria-label={placeholder}
              placeholder={placeholder}
              value={draft}
              rows={1}
              onChange={(event) => {
                if (sessionId === null && kept === null) setKept(automatic);
                setDraft(event.target.value);
              }}
              onPaste={attachments.onPaste}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing)
                  return;
                event.preventDefault();
                send();
              }}
              className="max-h-40 min-w-0 flex-1 resize-none bg-transparent font-mono text-[12.5px]/[1.75] text-ink outline-none [field-sizing:content] placeholder:text-placeholder"
            />
            {sessionId !== null && state?.turnRunning === true && (
              <button
                type="button"
                onClick={() => {
                  bridge.interrupt(sessionId).catch(report);
                }}
                className="shrink-0 rounded-md px-2 text-[11px] text-faint hover:bg-hover hover:text-ink"
              >
                {t('sessions.page.stop')}
              </button>
            )}
          </div>
          {/* The settings of a session the page shows, but has not started, are not known until its
              state comes, and show nothing until then rather than the defaults they would change
              from. */}
          <div
            className={
              sessionId !== null && state === null && starting === null ? 'invisible' : undefined
            }
          >
            <SessionSettings settings={choosers} />
          </div>
        </div>
      </div>
    </TimelineActionsContext>
  );
}

// An effort level as the settings show it, with a capital first letter as the other settings have:
// Medium for medium.
function effortLabel(level: ReasoningEffort): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

// Options with the provider's default among them, standing for no choice; without it, a Default
// option of the app's own leads.
function withDefault(options: SelectOption[], defaultLabel: string): SelectOption[] {
  return options.some((option) => option.value === '')
    ? options
    : [{ value: '', label: defaultLabel }, ...options];
}

// How much of the model's context window the conversation takes, near the end of the divider above
// the composer: the tokens in use against the window's size, each in whole thousands, with their share
// of it, such as 25k / 200k (12.5%), where the provider gives the size, and the tokens alone
// otherwise; the tooltip says what they are, in exact numbers.
function ContextUsage({ used, size }: { used: number; size: number | null }) {
  const { t, i18n } = useTranslation();
  const count = new Intl.NumberFormat(i18n.language);
  const thousands = (tokens: number) => `${count.format(Math.round(tokens / 1000))}k`;
  const percent = new Intl.NumberFormat(i18n.language, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const share = size === null || size === 0 ? null : percent.format(used / size);
  const label =
    size === null || share === null
      ? t('sessions.page.contextTokens', { tokens: thousands(used) })
      : t('sessions.page.context', { used: thousands(used), size: thousands(size), share });
  const detail =
    size === null || share === null
      ? t('sessions.page.contextTokens', { tokens: count.format(used) })
      : t('sessions.page.contextDetail', {
          used: count.format(used),
          size: count.format(size),
          share,
        });
  return (
    <span title={detail} aria-label={detail} className="shrink-0 text-[11px] leading-4 text-faint">
      {label}
    </span>
  );
}

function report(error: unknown): void {
  console.error('The session could not do that:', error);
}
