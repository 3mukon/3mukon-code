import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SelectOption } from '../../ui/renderer/select';
import type {
  MessageImage,
  ModelOption,
  PermissionMode,
  ProviderId,
  ReasoningEffort,
  SandboxLevel,
} from '../shared/events';
import type { RememberedChoice, SessionsBridge, SessionSummary } from '../shared/sessions';
import { Attachments, useAttachments } from './attachments';
import { SessionSettings, type Setting } from './session-settings';
import { Timeline, type RenderRequest } from './timeline';
import { TimelineActionsContext, timelineActions } from './timeline-actions';
import { rememberChoice, useOffers, useRemembered } from './use-offers';
import { useSession } from './use-session';

// What a page starts its session with. A null gateway is the provider's own configuration and a null
// model the provider's default; a null effort is the page's own starting effort for the model.
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

const modes: PermissionMode[] = ['auto', 'yolo'];
const sandboxes: SandboxLevel[] = ['read-only', 'workspace-write', 'full-access'];

// The effort a session starts with unless the user chooses another, whatever the provider's own
// default: medium wherever the model takes it, as every provider's models that take an effort do;
// otherwise the model's own default where the provider names it, or else the provider's default.
const STARTING_EFFORT: ReasoningEffort = 'medium';

function startingEffort(model: ModelOption | undefined): ReasoningEffort | null {
  if (model?.efforts.includes(STARTING_EFFORT) === true) return STARTING_EFFORT;
  return model?.defaultEffort ?? null;
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
}

// A session page. Before its first message it chooses the provider, gateway, model, reasoning effort,
// permission mode and sandbox level, and nothing runs; the first message starts the session, and from
// then on the page is the session, showing its activity, with everything but the provider still
// switchable. The model starts as the provider's default, under its own name, and the effort as the
// page's starting effort for it; until the provider's models come, the page says it is loading them,
// and a session started before they come keeps the provider's own defaults. Until the user changes
// one, the settings are those the folder's sessions last used, but for the permission mode, and a model
// or effort no longer offered gives way to the default; a session's settings, as it starts and as it
// switches, are remembered for its folder. Choosing yolo asks the
// user to confirm; a running session's sandbox level switches at once. The composer sends with Return
// and starts a new line with Shift-Return, with the images pasted into it or dropped on it, during a
// turn too, when the message goes to the running turn as the provider takes it; Stop ends the running
// turn.
export function SessionPage({
  bridge,
  folder,
  sessionId,
  summary,
  onStarted,
  renderRequest,
}: SessionPageProps) {
  const { t } = useTranslation();
  const state = useSession(bridge, sessionId);
  // The user's choice on this page, once they have made one.
  const [chosen, setChosen] = useState<Choice | null>(null);
  const remembered = useRemembered(bridge, folder);
  const choice: Choice =
    chosen ?? (remembered === undefined ? firstChoice : { ...remembered, mode: 'auto' });
  const [draft, setDraft] = useState('');
  const attachments = useAttachments();
  const actions = useMemo(() => timelineActions(bridge), [bridge]);
  // The first message, with its images, while the session starts.
  const [starting, setStarting] = useState<{ text: string; images: MessageImage[] } | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  // Whether the activity keeps its end in view as it grows; scrolling up stops that.
  const following = useRef(true);

  const provider = summary?.provider ?? choice.provider;
  const settings =
    sessionId === null
      ? choice
      : {
          provider,
          gateway: state?.gateway ?? null,
          model: state?.model ?? null,
          effort: state?.effort ?? null,
          mode: state?.mode ?? 'auto',
          sandbox: state?.sandbox ?? 'workspace-write',
        };
  const offers = useOffers(bridge, provider, settings.gateway);
  // A running session's own list once it reports one, else the provider's; missing while it loads.
  const models = (sessionId === null ? undefined : state?.models) ?? offers.models;
  // The model the provider uses when the session chooses none, under its own name, and the model in
  // use with its efforts. Before the session starts, a model the provider no longer offers, as one
  // remembered may be, gives way to the default.
  const defaultModel = models?.find((entry) => entry.default === true);
  const chosenModel =
    sessionId === null && models?.some((entry) => entry.id === settings.model) === false
      ? null
      : settings.model;
  const model =
    chosenModel === null ? defaultModel : models?.find((entry) => entry.id === chosenModel);
  const efforts = model?.efforts ?? [];
  // A choice of the default model itself shows as the default.
  const modelValue = chosenModel === defaultModel?.id ? '' : (chosenModel ?? '');
  // The effort without a choice: before the session starts the page's starting effort, and for a
  // running session without one the provider's default, under its own name where the provider says.
  // Before the session starts, an effort the model does not take gives way to the starting effort.
  const unchosenEffort =
    sessionId === null ? startingEffort(model) : (model?.defaultEffort ?? null);
  const chosenEffort =
    sessionId === null && model !== undefined && !efforts.includes(settings.effort ?? '')
      ? null
      : settings.effort;
  const effort = chosenEffort ?? unchosenEffort;
  const shownStart = state === null ? starting : null;
  const running = shownStart !== null || state?.turnRunning === true;
  const closed = state?.closed === true;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && following.current) element.scrollTop = element.scrollHeight;
  });

  const send = () => {
    const text = draft.trim();
    const { images } = attachments;
    if ((text === '' && images.length === 0) || shownStart !== null || closed) return;
    setDraft('');
    attachments.clear();
    setStartFailed(false);
    // A message that could not go comes back to the composer, with its images.
    const restore = () => {
      setDraft(text);
      attachments.restore(images);
    };
    if (sessionId === null) {
      setStarting({ text, images });
      const started = { ...choice, model: chosenModel, effort };
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
    bridge.send(sessionId, text, images).catch((error: unknown) => {
      report(error);
      restore();
    });
  };

  // A change of the page's choice, from what it shows.
  const change = (next: Partial<Choice>) => {
    setChosen((current) => ({ ...(current ?? choice), ...next }));
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
  // A choice before the session starts, or a switch once it runs.
  const switchTo = {
    provider: (value: string) => {
      change({ provider: value as ProviderId, gateway: null, model: null, effort: null });
    },
    gateway: (value: string) => {
      const gateway = value === '' ? null : value;
      if (sessionId === null) change({ gateway, model: null, effort: null });
      else bridge.setGateway(sessionId, gateway).then(switched({ gateway }), report);
    },
    model: (value: string) => {
      const next = value === '' ? null : value;
      if (sessionId === null) change({ model: next, effort: null });
      else bridge.setModel(sessionId, next).then(switched({ model: next }), report);
    },
    effort: (value: string) => {
      const level = value === '' ? null : value;
      if (sessionId === null) change({ effort: level });
      else bridge.setEffort(sessionId, level).then(switched({ effort: level }), report);
    },
    mode: (value: string) => {
      const mode = value as PermissionMode;
      if (sessionId !== null) {
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
      if (sessionId === null) change({ sandbox });
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
            label: t(`providers.${id}`),
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
            options: withChosen(
              [
                // Where the default is not known, the app's Default stands for it.
                ...(unchosenEffort === null
                  ? [{ value: '', label: t('sessions.page.defaultEffort') }]
                  : []),
                ...efforts.map((level) => ({ value: level, label: effortLabel(level) })),
              ],
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
          <Timeline
            state={state}
            agent={providerName}
            {...(shownStart === null ? {} : { starting: shownStart })}
            {...(renderRequest === undefined ? {} : { renderRequest })}
          />
          {startFailed && <p className="my-3 text-del">{t('sessions.page.startFailed')}</p>}
        </section>
        {/* The composer, on which images can be dropped, marked while they are dragged over it. */}
        <div
          {...attachments.dropZone}
          className={`mx-5 mb-3 rounded-md ${attachments.dropping ? 'outline-2 outline-offset-2 outline-accent outline-dashed' : ''}`}
        >
          {/* The divider above the composer, with the context in use near its end. */}
          <div className="flex h-4 items-center gap-2">
            <div className="h-px min-w-0 flex-1 bg-line" />
            {state?.context !== undefined && (
              <>
                <ContextUsage {...state.context} />
                <div className="h-px w-3 shrink-0 bg-line" />
              </>
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
              disabled={closed}
              onChange={(event) => {
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
            {running && sessionId !== null && (
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
          <SessionSettings settings={choosers} />
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
// the composer: the tokens in use against the window's size, with their share of it, such as
// 25,000 / 200,000 (12.5%), where the provider gives the size, and the tokens alone otherwise; the
// tooltip says what they are.
function ContextUsage({ used, size }: { used: number; size: number | null }) {
  const { t, i18n } = useTranslation();
  const count = new Intl.NumberFormat(i18n.language);
  const percent = new Intl.NumberFormat(i18n.language, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const counts =
    size === null || size === 0
      ? null
      : { used: count.format(used), size: count.format(size), share: percent.format(used / size) };
  const label =
    counts === null
      ? t('sessions.page.contextTokens', { tokens: count.format(used) })
      : t('sessions.page.context', counts);
  const detail =
    counts === null
      ? t('sessions.page.contextTokens', { tokens: count.format(used) })
      : t('sessions.page.contextDetail', counts);
  return (
    <span title={detail} aria-label={detail} className="shrink-0 text-[11px] leading-4 text-faint">
      {label}
    </span>
  );
}

function report(error: unknown): void {
  console.error('The session could not do that:', error);
}
