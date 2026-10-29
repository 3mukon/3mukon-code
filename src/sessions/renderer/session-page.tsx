import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select, type SelectOption } from '../../ui/renderer/select';
import type {
  ModelOption,
  PermissionMode,
  ProviderId,
  ReasoningEffort,
  SandboxLevel,
} from '../shared/events';
import type { SessionsBridge, SessionSummary } from '../shared/sessions';
import { Timeline } from './timeline';
import { useOffers } from './use-offers';
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
}

// A session page. Before its first message it chooses the provider, gateway, model, reasoning effort,
// permission mode and sandbox level, and nothing runs; the first message starts the session, and from
// then on the page is the session, showing its activity, with everything but the provider still
// switchable. The model starts as the provider's default, under its own name, and the effort as the
// page's starting effort for it; until the provider's models come, the page says it is loading them,
// and a session started before they come keeps the provider's own defaults. Choosing yolo asks the
// user to confirm; a running session's sandbox level switches at once. The composer sends with Return
// and starts a new line with Shift-Return; Stop ends the running turn.
export function SessionPage({ bridge, folder, sessionId, summary, onStarted }: SessionPageProps) {
  const { t } = useTranslation();
  const state = useSession(bridge, sessionId);
  const [choice, setChoice] = useState<Choice>(firstChoice);
  const [draft, setDraft] = useState('');
  // The first message while the session starts.
  const [starting, setStarting] = useState<string | null>(null);
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
  // use with its efforts.
  const defaultModel = models?.find((entry) => entry.default === true);
  const model =
    settings.model === null ? defaultModel : models?.find((entry) => entry.id === settings.model);
  const efforts = model?.efforts ?? [];
  // A choice of the default model itself shows as the default.
  const modelValue = settings.model === defaultModel?.id ? '' : (settings.model ?? '');
  // The effort without a choice: before the session starts the page's starting effort, and for a
  // running session without one the provider's default, under its own name where the provider says.
  const unchosenEffort =
    sessionId === null ? startingEffort(model) : (model?.defaultEffort ?? null);
  const effort = settings.effort ?? unchosenEffort;
  const shownStart = state === null ? starting : null;
  const running = shownStart !== null || state?.turnRunning === true;
  const closed = state?.closed === true;

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && following.current) element.scrollTop = element.scrollHeight;
  });

  const send = () => {
    const text = draft.trim();
    if (text === '' || running || closed) return;
    setDraft('');
    setStartFailed(false);
    if (sessionId === null) {
      setStarting(text);
      bridge
        .start({ ...choice, effort, cwd: folder, message: text })
        .then(onStarted, (error: unknown) => {
          report(error);
          setStarting(null);
          setStartFailed(true);
          setDraft(text);
        });
      return;
    }
    bridge.send(sessionId, text).catch((error: unknown) => {
      report(error);
      setDraft(text);
    });
  };

  // A choice before the session starts, or a switch once it runs.
  const switchTo = {
    provider: (value: string) => {
      setChoice((current) => ({
        ...current,
        provider: value as ProviderId,
        gateway: null,
        model: null,
        effort: null,
      }));
    },
    gateway: (value: string) => {
      const gateway = value === '' ? null : value;
      if (sessionId !== null) bridge.setGateway(sessionId, gateway).catch(report);
      else setChoice((current) => ({ ...current, gateway, model: null, effort: null }));
    },
    model: (value: string) => {
      const model = value === '' ? null : value;
      if (sessionId !== null) bridge.setModel(sessionId, model).catch(report);
      else setChoice((current) => ({ ...current, model, effort: null }));
    },
    effort: (value: string) => {
      const level = value === '' ? null : value;
      if (sessionId !== null) bridge.setEffort(sessionId, level).catch(report);
      else setChoice((current) => ({ ...current, effort: level }));
    },
    mode: (value: string) => {
      const mode = value as PermissionMode;
      if (sessionId !== null) {
        bridge.setMode(sessionId, mode).catch(report);
      } else if (mode === 'yolo') {
        bridge.confirmYolo().then((confirmed) => {
          if (confirmed) setChoice((current) => ({ ...current, mode }));
        }, report);
      } else {
        setChoice((current) => ({ ...current, mode }));
      }
    },
    sandbox: (value: string) => {
      const sandbox = value as SandboxLevel;
      if (sessionId !== null) bridge.setSandbox(sessionId, sandbox).catch(report);
      else setChoice((current) => ({ ...current, sandbox }));
    },
  };

  const providerName = t(`providers.${provider}`);
  const placeholder = t('sessions.page.message', { provider: providerName });
  const withChosen = (options: SelectOption[], value: string | null): SelectOption[] =>
    value === null || options.some((option) => option.value === value)
      ? options
      : [...options, { value, label: value }];

  return (
    <div className="grid h-full min-h-0 grid-rows-[1fr_auto]">
      <section
        ref={scroller}
        aria-label={t('sessions.page.activity')}
        onScroll={(event) => {
          const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
          following.current = scrollHeight - scrollTop - clientHeight < 32;
        }}
        className="min-h-0 overflow-y-auto px-5 pt-2 pb-5 font-mono text-[12.5px]/[1.75] text-muted"
      >
        <Timeline state={state} {...(shownStart === null ? {} : { starting: shownStart })} />
        {startFailed && <p className="my-3 text-del">{t('sessions.page.startFailed')}</p>}
      </section>
      <div className="mx-5 mb-3 border-t border-line pt-3">
        <div className="flex items-end gap-2">
          <textarea
            aria-label={placeholder}
            placeholder={placeholder}
            value={draft}
            rows={1}
            disabled={closed}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              send();
            }}
            className="max-h-40 min-w-0 flex-1 resize-none bg-transparent font-mono text-[12.5px]/[1.75] text-ink outline-none [field-sizing:content] placeholder:text-faint"
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
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {sessionId === null ? (
            <Select
              label={t('sessions.page.provider')}
              value={provider}
              // The chosen provider alone until the app's providers come.
              options={(offers.providers ?? [provider]).map((id) => ({
                value: id,
                label: t(`providers.${id}`),
              }))}
              onChange={switchTo.provider}
            />
          ) : (
            <span className="px-1 text-[11px] text-faint">{providerName}</span>
          )}
          {(offers.gateways.length > 0 || settings.gateway !== null) && (
            <Select
              label={t('sessions.page.gateway')}
              value={settings.gateway ?? ''}
              options={withChosen(
                [
                  { value: '', label: t('sessions.page.noGateway') },
                  ...offers.gateways.map((name) => ({ value: name, label: name })),
                ],
                settings.gateway,
              )}
              onChange={switchTo.gateway}
            />
          )}
          {models === undefined ? (
            <span className="px-1 text-[11px] text-faint">{t('sessions.page.loadingModels')}</span>
          ) : (
            <Select
              label={t('sessions.page.model')}
              value={modelValue}
              options={withChosen(
                withDefault(
                  models.map((entry) => ({
                    value: entry === defaultModel ? '' : entry.id,
                    label: entry.label,
                  })),
                  t('sessions.page.defaultModel'),
                ),
                modelValue === '' ? null : modelValue,
              )}
              onChange={switchTo.model}
            />
          )}
          {(efforts.length > 0 || effort !== null) && (
            <Select
              label={t('sessions.page.effort')}
              value={effort ?? ''}
              options={withChosen(
                [
                  // Where the default is not known, the app's Default stands for it.
                  ...(unchosenEffort === null
                    ? [{ value: '', label: t('sessions.page.defaultEffort') }]
                    : []),
                  ...efforts.map((level) => ({ value: level, label: level })),
                ],
                effort,
              )}
              onChange={switchTo.effort}
            />
          )}
          <Select
            label={t('sessions.page.mode')}
            value={settings.mode}
            options={modes.map((mode) => ({ value: mode, label: t(`sessions.mode.${mode}`) }))}
            onChange={switchTo.mode}
          />
          <Select
            label={t('sessions.page.sandbox')}
            value={settings.sandbox}
            options={sandboxes.map((level) => ({
              value: level,
              label: t(`sessions.sandbox.${level}`),
            }))}
            onChange={switchTo.sandbox}
          />
          {state?.context !== undefined && <ContextUsage {...state.context} />}
        </div>
      </div>
    </div>
  );
}

// Options with the provider's default among them, standing for no choice; without it, a Default
// option of the app's own leads.
function withDefault(options: SelectOption[], defaultLabel: string): SelectOption[] {
  return options.some((option) => option.value === '')
    ? options
    : [{ value: '', label: defaultLabel }, ...options];
}

// How much of the model's context window the conversation takes, at the composer's bottom right: the
// tokens in use against the window's size, with their share of it, such as 25,000 / 200,000 (12.5%),
// where the provider gives the size, and the tokens alone otherwise; the tooltip says what they are.
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
    <span
      title={detail}
      aria-label={detail}
      className="ml-auto shrink-0 px-1 text-[11px] text-faint"
    >
      {label}
    </span>
  );
}

function report(error: unknown): void {
  console.error('The session could not do that:', error);
}
