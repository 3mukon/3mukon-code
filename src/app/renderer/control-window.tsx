import { StrictMode, useEffect, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
import { ForegroundControlBar } from '../../computer/renderer/foreground-control';
import type {
  ControlWindowBridge,
  ControlWindowButton,
  ControlWindowSnapshot,
} from '../../computer/shared/computer';
import { initI18n, switchLanguage } from '../../i18n/renderer/i18n';
import { CONTROL_SIZE, looks, marked, REVISION_BITS } from '../shared/control-window';
import './app.css';

declare global {
  interface Window {
    readonly controlWindow: ControlWindowBridge;
  }
}

function ControlWindow({ bridge }: { bridge: ControlWindowBridge }) {
  const { t } = useTranslation();
  const [state, setState] = useState<ControlWindowSnapshot>({ revision: -1, control: null });
  useEffect(() => {
    let mounted = true;
    const receive = (next: ControlWindowSnapshot) => {
      if (mounted) setState((current) => (next.revision > current.revision ? next : current));
    };
    const stop = bridge.onState(receive);
    void bridge.snapshot().then(receive, () => undefined);
    return () => {
      mounted = false;
      stop();
    };
  }, [bridge]);

  const { revision, control } = state;
  useEffect(() => {
    document.title = t('computer.setting.label');
  }, [t]);
  useLayoutEffect(() => {
    if (!control) return;
    if (document.documentElement.lang !== control.language) switchLanguage([control.language]);
    const painted = requestAnimationFrame(() => {
      const buttons: ControlWindowButton[] = [];
      for (const button of document.querySelectorAll<HTMLButtonElement>(
        '[data-look="rest"] button',
      )) {
        const label = button.textContent.trim();
        const { x, y, width, height } = button.getBoundingClientRect();
        buttons.push({
          command: label === t('computer.handBack') ? 'hand-back' : 'stop',
          label,
          enabled: !button.disabled,
          bounds: { x, y, width, height },
        });
      }
      void bridge.ready(revision, buttons).catch(() => undefined);
    });
    return () => {
      cancelAnimationFrame(painted);
    };
  }, [bridge, revision, control, t]);

  return (
    control && (
      <>
        <RevisionMark revision={revision} />
        {looks.map((look) => (
          <div
            key={look}
            data-look={look}
            style={CONTROL_SIZE}
            className={`flex items-center justify-center [&_*]:animate-none ${LOOKS[look]}`}
          >
            <ForegroundControlBar
              state={control.state}
              session={control.session}
              application={control.application}
              shortcut={control.stopShortcut}
              onStop={unhandled}
              onHandBack={unhandled}
            />
          </div>
        ))}
      </>
    )
  );
}

const LOOKS: Record<(typeof looks)[number], string> = {
  rest: '',
  hover: '[&_button:enabled]:bg-hover',
  pressed: '[&_button:enabled]:bg-line',
};

// Tells main which revision a picture shows; main takes it out of the picture.
function RevisionMark({ revision }: { revision: number }) {
  return (
    <div aria-hidden="true" className="pointer-events-none fixed top-0 left-0 flex">
      {Array.from({ length: REVISION_BITS + 1 }, (_, cell) => (
        <span
          key={cell}
          style={{
            width: 1,
            height: 1,
            backgroundColor: marked(revision, cell) ? '#000' : 'transparent',
          }}
        />
      ))}
    </div>
  );
}

const unhandled = () => Promise.resolve(false);

initI18n();
const root = document.getElementById('root');
if (!root) throw Error('The control window has no root.');
createRoot(root).render(
  <StrictMode>
    <ControlWindow bridge={window.controlWindow} />
  </StrictMode>,
);
