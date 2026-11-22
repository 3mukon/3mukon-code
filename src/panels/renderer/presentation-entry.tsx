import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/renderer/button';
import { PanelRight } from '../../ui/renderer/icons';
import type { ShowOutcome } from '../shared/presentation';

// A presentation as its session's activity records it, in place of the tool call that made it, as a
// tool call's line: a panel's sign, what the session showed, by the presentation's title, in the ink,
// with Show while none of its panels is open, which asks to see it again. Where it cannot be shown,
// the line says why; once shown, nothing more.
export function PresentationEntry({
  title,
  open,
  onShow,
}: {
  title: string;
  open: boolean;
  onShow: () => Promise<ShowOutcome>;
}) {
  const { t } = useTranslation();
  // The user's latest Show, with what it came to once main answers. It lapses as soon as the
  // presentation opens or closes, by Show, its agent or the user, so that its words never stand
  // beside an open presentation and an answer that comes after says nothing.
  const [attempt, setAttempt] = useState<{ outcome?: ShowOutcome } | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    setAttempt(null);
  }
  const show = () => {
    const mine = {};
    setAttempt(mine);
    const settle = (outcome: ShowOutcome) => {
      setAttempt((latest) => (latest === mine ? { outcome } : latest));
    };
    onShow().then(settle, () => {
      settle('unavailable');
    });
  };
  const outcome = attempt?.outcome;
  return (
    <p className="my-0.5 flex min-w-0 items-center gap-2 text-muted">
      <PanelRight className="size-3.5 shrink-0 text-faint" />
      <span className="min-w-0 truncate text-ink" title={title}>
        {t('panels.showed', { title })}
      </span>
      {!open && <Button small label={t('panels.show')} onClick={show} />}
      <span role="status" className="min-w-0 truncate">
        {outcome !== undefined && outcome !== 'shown' && t(`panels.showOutcome.${outcome}`)}
      </span>
    </p>
  );
}
