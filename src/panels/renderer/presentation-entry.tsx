import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ShowOutcome } from '../shared/presentation';

// A presentation as its session's activity records it, under the tool call that made it: what the
// session showed, by the presentation's title, with Show while none of its panels is open, which asks
// to see it again. Where it cannot be shown, the line says why; once shown, nothing more.
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
    <p className="my-1 flex min-w-0 items-baseline gap-2 text-[12.5px] text-muted">
      <span className="min-w-0 truncate" title={title}>
        {t('panels.showed', { title })}
      </span>
      {!open && (
        <button
          type="button"
          onClick={show}
          className="shrink-0 rounded-sm px-1 text-faint hover:bg-hover hover:text-ink"
        >
          {t('panels.show')}
        </button>
      )}
      <span role="status" className="min-w-0 truncate">
        {outcome !== undefined && outcome !== 'shown' && t(`panels.showOutcome.${outcome}`)}
      </span>
    </p>
  );
}
