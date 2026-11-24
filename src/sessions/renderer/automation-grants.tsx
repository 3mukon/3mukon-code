import { useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '../../ui/renderer/button';
import { addCover } from '../../ui/renderer/cover';
import { StatusDot } from '../../ui/renderer/status-dot';
import { Tag } from '../../ui/renderer/tag';
import type { Grant } from '../shared/automation';
import { sharingTag, sharingWords, targetName } from './automation-labels';

// How far the sheet keeps from the window's edges and from its button.
const EDGE = 8;
const GAP = 4;

// While a session holds grants, a line above its composer's divider says how many, in the ink, and
// what each lets its agent use, a page by its host and an application by its name, in small faint
// type, as the line of what the session uses does; Show opens a sheet that lists each grant, for this
// operation or for this session, with End, which ends it at once, queued work included (ADR-0027), and
// reads Hide while the sheet is open, which it closes again.
export function GrantsLine({
  grants,
  onEnd,
}: {
  grants: readonly Grant[];
  // Ends one grant; false where it could not.
  onEnd: (grantId: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [listing, setListing] = useState<{ box: DOMRect; opener: HTMLButtonElement } | null>(null);
  if (grants.length === 0) return null;
  return (
    <div className="mb-1.5 flex min-w-0 items-center gap-2 text-[11px] text-faint">
      <StatusDot status="live" />
      <span className="min-w-0 truncate">
        <span className="font-medium text-ink">
          {t('sessions.automation.grants.count', { count: grants.length })}
        </span>
        {grants.map((grant) => ` · ${grantWords(grant, t)}`).join('')}
      </span>
      <span className="flex-1" />
      <Button
        small
        label={t(
          listing === null ? 'sessions.automation.line.show' : 'sessions.automation.grants.hide',
        )}
        expanded={listing !== null}
        onClick={(event) => {
          const opener = event.currentTarget;
          setListing((open) =>
            open === null ? { box: opener.getBoundingClientRect(), opener } : null,
          );
        }}
      />
      {listing !== null && (
        <GrantsSheet
          grants={grants}
          below={listing.box}
          opener={listing.opener}
          onEnd={onEnd}
          onClose={(byKey) => {
            setListing(null);
            if (byKey) listing.opener.focus();
          }}
        />
      )}
    </div>
  );
}

// The grants as a sheet of the window's paper under a dashed line, as a menu is drawn, above the
// button that opened it and level with its right edge, with the keyboard focus on the first End, each
// End telling VoiceOver which grant it ends. As a menu does, it closes at Escape, which gives the
// focus back to the button, at a press of the pointer beside it, though not on its own button, whose
// click closes it, and as the window loses the focus or changes size; it lies over the page, so a web
// page in a panel shows still beneath it.
function GrantsSheet({
  grants,
  below,
  opener,
  onEnd,
  onClose,
}: {
  grants: readonly Grant[];
  // The box of the button the sheet opens above.
  below: DOMRect;
  // That button, a press on which is its own to answer.
  opener: HTMLButtonElement;
  onEnd: (grantId: string) => Promise<boolean>;
  // Called as the sheet closes; with true where the user closed it with Escape.
  onClose: (byKey: boolean) => void;
}) {
  const { t } = useTranslation();
  const sheet = useRef<HTMLDivElement>(null);
  const [ending, setEnding] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState(false);
  const dismiss = useEffectEvent(onClose);
  useLayoutEffect(() => {
    const element = sheet.current;
    if (element === null) return;
    element.showPopover();
    const { width, height } = element.getBoundingClientRect();
    const left = Math.min(below.right - width, window.innerWidth - EDGE - width);
    const top = below.top - GAP - height;
    element.style.left = `${String(Math.max(EDGE, left))}px`;
    element.style.top = `${String(Math.max(EDGE, top))}px`;
    const uncover = addCover(element);
    element.querySelector<HTMLButtonElement>('button')?.focus();
    const leave = () => {
      dismiss(false);
    };
    const beside = (event: Event) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target === null || (!element.contains(target) && !opener.contains(target))) leave();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      dismiss(true);
    };
    document.addEventListener('pointerdown', beside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('blur', leave);
    window.addEventListener('resize', leave);
    return () => {
      document.removeEventListener('pointerdown', beside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', leave);
      window.removeEventListener('resize', leave);
      uncover();
      element.hidePopover();
    };
  }, [below, opener]);
  const end = (id: string) => {
    setFailed(false);
    setEnding((now) => new Set(now).add(id));
    const settle = (done: boolean) => {
      setEnding((now) => {
        const next = new Set(now);
        next.delete(id);
        return next;
      });
      if (!done) setFailed(true);
    };
    onEnd(id).then(settle, () => {
      settle(false);
    });
  };
  const title = t('sessions.automation.grants.title');
  return (
    <div
      ref={sheet}
      popover="manual"
      role="dialog"
      aria-label={title}
      className="inset-auto m-0 w-[350px] max-w-[calc(100vw-16px)] rounded-md border border-dashed border-menu-line paper p-1 font-sans text-[12px] leading-6 text-ink"
    >
      <p className="px-2.5 pt-0.5 text-[11px] text-faint">{title}</p>
      <ul>
        {grants.map((grant) => (
          <li key={grant.id} className="flex min-w-0 items-center gap-2 px-2.5">
            <Tag>{grantTag(grant, t)}</Tag>
            <span className="min-w-0 truncate">{grantName(grant)}</span>
            <span className="flex-1" />
            <span className="shrink-0 text-[11px] text-faint">
              {t(`sessions.automation.grants.scope.${grant.scope}`)}
            </span>
            <Button
              small
              label={t('sessions.automation.grants.end')}
              spoken={t('sessions.automation.grants.endNamed', { grant: grantWords(grant, t) })}
              disabled={ending.has(grant.id)}
              onClick={() => {
                end(grant.id);
              }}
            />
          </li>
        ))}
      </ul>
      {failed && (
        <p role="status" className="px-2.5 text-[11px] text-del">
          {t('sessions.automation.grants.endFailed')}
        </p>
      )}
    </div>
  );
}

// What a grant lets the agent use, in the line's words.
function grantWords(grant: Grant, t: TFunction): string {
  const { target } = grant;
  if (grant.operationKind === 'browser-tab') {
    const site = targetName(target);
    const where = target.sharing === 'global' ? 'chromeTab' : 'appTab';
    return site === null
      ? t(`sessions.automation.grants.${where}Blank`)
      : t(`sessions.automation.grants.${where}`, { site });
  }
  const name = target.applicationName ?? target.name;
  const app =
    name === '' ? t('sessions.automation.someApp') : t('sessions.automation.appName', { name });
  const words = {
    'application-background': 'background',
    'application-foreground': 'foreground',
    'system-dialog': 'dialog',
  } as const;
  return t(`sessions.automation.grants.${words[grant.operationKind]}`, { app });
}

// A grant's kind, as its tag in the sheet names it: how a page is shared, or where an application's
// work runs, or a dialog.
function grantTag(grant: Grant, t: TFunction): string {
  switch (grant.operationKind) {
    case 'browser-tab':
      return (
        sharingTag(sharingWords(grant.target.sharing, grant.target.browser, null), t) ??
        t('sessions.automation.kind.browser')
      );
    case 'application-background':
      return t('sessions.automation.delivery.background');
    case 'application-foreground':
      return t('sessions.automation.delivery.foreground');
    case 'system-dialog':
      return t('sessions.automation.grants.dialogTag');
  }
}

// What a grant is for, by name: a page's host, or an application's name.
function grantName(grant: Grant): string {
  const { target } = grant;
  if (grant.operationKind === 'browser-tab') return targetName(target) ?? '';
  return target.applicationName ?? target.name;
}
