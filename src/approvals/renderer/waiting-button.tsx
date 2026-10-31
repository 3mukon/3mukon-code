import { useTranslation } from 'react-i18next';
import type { SessionSummary } from '../../sessions/shared/sessions';
import { WaitingIndicator } from '../../ui/renderer/waiting-indicator';
import { waitingSessions } from '../shared/waiting';

// The count of sessions waiting on the user, as the ui module's waiting indicator, which shows the
// session that has waited longest; nothing while none waits.
export function WaitingButton({
  sessions,
  onShow,
}: {
  sessions: readonly SessionSummary[];
  onShow: (session: SessionSummary) => void;
}) {
  const { t } = useTranslation();
  const { count, longest } = waitingSessions(sessions);
  return (
    <WaitingIndicator
      count={count}
      label={t('approvals.waiting', { count })}
      onActivate={() => {
        if (longest !== undefined) onShow(longest);
      }}
    />
  );
}
