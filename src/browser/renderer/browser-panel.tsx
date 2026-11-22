import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ageOf, useNow } from '../../ui/renderer/age';
import { Button } from '../../ui/renderer/button';
import { ChevronLeft, ChevronRight, Lock, Pointer, RotateCw, X } from '../../ui/renderer/icons';
import { StatusDot } from '../../ui/renderer/status-dot';
import type { BrowserTabCommand, BrowserTabState } from '../shared/browser';

// What the tab's session does with it, as its automation says: whether it holds the tab, as from
// the agent's first use of it until the turn ends, whether the agent acts on it now, or is stopping,
// and whether it waits for the user's answer before it works in the tab.
export interface TabUse {
  held: boolean;
  acting: boolean;
  stopping: boolean;
  waiting: boolean;
}

export const NO_USE: TabUse = { held: false, acting: false, stopping: false, waiting: false };

// A browser tab in a panel of its own (ADR-0027), whose header names the page and how it
// is shared: Back, Forward and Reload, which are the user's, Reload turning into Stop Loading while
// the page loads, and the page's address; under them the page itself, which whoever composes the
// panel lays in its frame, and the window's paper in its place while it loads, once it cannot load,
// saying why, with Try Again, and once the tab has closed. While the agent acts, a thin line runs
// along the page's top, and a chip under the page names the session, with Stop; while the user has
// the tab, the chip says so, with Hand Back, which returns it; while the agent waits for the user's
// answer to work in the tab, the chip says so, with Show, which takes the user to the question, and
// the page stays the user's to use. A Chrome tab's panel shows a non-interactive preview with its
// frame's age. Open in Chrome brings that same tab to the front. The chip's strip stays
// while the session holds the tab, so that the page keeps its size as the chip comes and goes. A
// control that did not go says so.
export function BrowserPanel({
  state,
  session,
  use,
  onCommand,
  onStop,
  onShowQuestion,
  page,
}: {
  // The tab's state, as the browser last reported it: nothing before it has, null once it has ended.
  state: BrowserTabState | null | undefined;
  // The name of the session that owns the tab.
  session: string;
  use: TabUse;
  // Sends one of the user's controls; whether it went.
  onCommand: (command: BrowserTabCommand) => Promise<boolean>;
  // Stops the session's work, as the chip's Stop asks; whether it did.
  onStop: () => Promise<boolean>;
  // Takes the user to the question the agent waits for.
  onShowQuestion: () => void;
  // The page itself, once whoever composes the panel can show it, told how to report when the frame
  // it shows was taken.
  page?: (onFrame: (capturedAt: number | null) => void) => ReactNode;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const [frameAt, setFrameAt] = useState<number | null>(null);
  const now = useNow(frameAt !== null);
  const run = (step: () => Promise<boolean>) => {
    setFailed(false);
    step().then(
      (done) => {
        if (!done) setFailed(true);
      },
      () => {
        setFailed(true);
      },
    );
  };
  const command = (sent: BrowserTabCommand) => {
    run(() => onCommand(sent));
  };
  if (state === undefined) return <div className="h-full" />;
  if (state === null) {
    return (
      <div className="relative h-full">
        <Paper>
          <p className="text-faint">{t('browser.panel.closed')}</p>
        </Paper>
      </div>
    );
  }
  const place = placeOf(state.address);
  const external = state.browser !== 'embedded';
  const userHas = state.control === 'user';
  const chip = userHas ? 'user' : use.waiting ? 'waiting' : use.acting ? 'acting' : null;
  const strip = use.held || use.waiting || userHas;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-1.5 px-3 pb-2">
        {external ? (
          <>
            <span className="min-w-0 truncate text-[12px] text-muted">
              {[
                t('browser.panel.previewLabel'),
                ...(frameAt === null ? [] : [ageWords(now - frameAt, t)]),
              ].join(' · ')}
            </span>
            <span className="flex-1" />
          </>
        ) : (
          <>
            <Control
              label={t('browser.panel.back')}
              disabled={!state.canGoBack}
              onClick={() => {
                command({ kind: 'back' });
              }}
            >
              <ChevronLeft className="size-3.5" />
            </Control>
            <Control
              label={t('browser.panel.forward')}
              disabled={!state.canGoForward}
              onClick={() => {
                command({ kind: 'forward' });
              }}
            >
              <ChevronRight className="size-3.5" />
            </Control>
            {state.loading ? (
              <Control
                label={t('browser.panel.stopLoading')}
                onClick={() => {
                  command({ kind: 'stop-loading' });
                }}
              >
                <X className="size-3.5" />
              </Control>
            ) : (
              <Control
                label={t('browser.panel.reload')}
                disabled={state.address === null}
                onClick={() => {
                  command({ kind: 'reload' });
                }}
              >
                <RotateCw className="size-3.5" />
              </Control>
            )}
          </>
        )}
        {!external && (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-md border border-dashed border-line px-2 py-0.5 font-mono text-[12px] whitespace-nowrap text-muted">
            {place?.secure === true && <Lock className="size-3 shrink-0" />}
            <span className="min-w-0 truncate">{place?.full ?? t('browser.panel.blank')}</span>
          </span>
        )}
        <span role="status" className="shrink-0 text-[11px] text-del empty:hidden">
          {failed ? t('browser.failed') : ''}
        </span>
        {external && (
          <Button
            label={t('browser.panel.openChrome')}
            disabled={state.address === null}
            onClick={() => {
              command({ kind: 'open-external' });
            }}
          />
        )}
      </div>
      <div className={`relative mx-3 min-h-0 flex-1 ${strip ? '' : 'mb-3'}`}>
        <div className="relative h-full overflow-hidden rounded-md border border-line">
          {state.address !== null && page?.(setFrameAt)}
          {state.error !== null ? (
            <Paper>
              <p className="font-semibold text-ink">
                {t('browser.panel.cantReach', { host: place?.host ?? state.title })}
              </p>
              <p className="mt-0.5 mb-2.5 text-muted">{t(`browser.panel.error.${state.error}`)}</p>
              {!external && (
                <Button
                  label={t('browser.panel.tryAgain')}
                  onClick={() => {
                    command({ kind: 'reload' });
                  }}
                />
              )}
            </Paper>
          ) : state.loading ? (
            <Paper>
              <p className="text-faint">{t('browser.panel.loading')}</p>
            </Paper>
          ) : (
            state.address === null && (
              <Paper>
                <p className="text-faint">{t('browser.panel.blank')}</p>
              </Paper>
            )
          )}
        </div>
        {/* Along the frame's top edge, so that it never meets the page, which keeps its size. */}
        {chip === 'acting' && !external && (
          <div
            aria-hidden="true"
            className="absolute inset-x-0 -top-px h-0.5 rounded-t-md bg-accent"
          />
        )}
      </div>
      {strip && (
        <div className="flex h-11 shrink-0 items-center px-3">
          {chip !== null && (
            <div className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-dashed border-menu-line paper py-[5px] pr-1.5 pl-2.5 text-[12px] text-ink">
              {chip === 'user' ? (
                <Pointer className="size-3.5 shrink-0" />
              ) : (
                <StatusDot status={chip === 'waiting' ? 'waiting' : 'live'} />
              )}
              <span className="min-w-0 truncate">
                {chip === 'user'
                  ? t('browser.panel.control')
                  : chip === 'waiting'
                    ? t('browser.panel.waiting', { session })
                    : external
                      ? t('browser.panel.actingIn', {
                          session,
                          browser: t(`browser.panel.browserName.${state.browser}`),
                        })
                      : t('browser.panel.acting', { session })}
              </span>
              {chip === 'user' ? (
                <Button
                  label={t('browser.panel.handBack')}
                  onClick={() => {
                    command({ kind: 'hand-back' });
                  }}
                />
              ) : chip === 'waiting' ? (
                <Button label={t('browser.panel.show')} onClick={onShowQuestion} />
              ) : (
                <Button
                  label={t('browser.panel.stop')}
                  disabled={use.stopping}
                  onClick={() => {
                    run(onStop);
                  }}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// How old a preview's frame is, in the panel's words.
function ageWords(milliseconds: number, t: TFunction): string {
  const { unit, count } = ageOf(milliseconds);
  return t(`browser.panel.age.${unit}`, { count });
}

// An address as the panel shows it: its host, its host and path, and whether its connection is
// secure.
function placeOf(address: string | null): { host: string; full: string; secure: boolean } | null {
  if (address === null) return null;
  try {
    const url = new URL(address);
    const path = url.pathname === '/' ? '' : url.pathname;
    return { host: url.host, full: `${url.host}${path}`, secure: url.protocol === 'https:' };
  } catch {
    return { host: address, full: address, secure: false };
  }
}

// The window's paper in the page's place, with what it says in the middle.
function Paper({ children }: { children: ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center paper px-6 text-center text-[12px]">
      {children}
    </div>
  );
}

function Control({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-[22px] w-6 shrink-0 place-items-center rounded-[5px] text-muted enabled:hover:bg-hover enabled:hover:text-ink disabled:text-faint"
    >
      {children}
    </button>
  );
}
