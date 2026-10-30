import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from '../../ui/renderer/icons';
import { Select, type SelectOption } from '../../ui/renderer/select';

// One of a session page's settings: a choice, or text for what the page cannot choose, such as a
// running session's provider or a list still loading. Those in the summary name the settings while
// one dropdown holds them all.
export type Setting = { label: string; summary: boolean } & (
  { value: string; options: SelectOption[]; onChange: (value: string) => void } | { text: string }
);

// A session page's settings under its composer: a row of compact selects while it has room for them
// on one line, and otherwise one button, naming the settings in the summary, whose dropdown holds
// them all. The row stays laid out while hidden, so that its width says when it fits again.
export function SessionSettings({ settings }: { settings: Setting[] }) {
  const { t } = useTranslation();
  const area = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(true);
  const dropdown = useId();

  useLayoutEffect(() => {
    const [areaElement, rowElement] = [area.current, row.current];
    if (areaElement === null || rowElement === null) return;
    const measure = () => {
      setFits(rowElement.offsetWidth <= areaElement.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(areaElement);
    observer.observe(rowElement);
    return () => {
      observer.disconnect();
    };
  }, []);

  const summary = settings
    .filter((setting) => setting.summary)
    .map(shownText)
    .join(' · ');

  return (
    <div ref={area} className="relative mt-1.5 min-w-0">
      <div
        inert={!fits}
        className={fits ? undefined : 'invisible absolute inset-x-0 top-0 h-0 overflow-hidden'}
      >
        <div ref={row} className="flex w-max items-center gap-x-2">
          {settings.map((setting) => (
            <Control key={setting.label} setting={setting} />
          ))}
        </div>
      </div>
      {!fits && (
        <>
          <button
            type="button"
            popoverTarget={dropdown}
            aria-label={t('sessions.page.settingsSummary', { summary })}
            title={summary}
            className="flex max-w-full min-w-0 items-center gap-0.5 rounded-md px-1 text-[11px] text-faint hover:text-ink"
          >
            <span className="min-w-0 truncate">{summary}</span>
            <ChevronDown className="size-3 shrink-0" />
          </button>
          <div
            id={dropdown}
            popover="auto"
            role="group"
            aria-label={t('sessions.page.settings')}
            className="inset-auto m-0 mb-1 w-max max-w-[calc(100vw-16px)] rounded-md border border-dashed border-menu-line paper px-2 py-1.5 [position-area:top_span-right] [position-try-fallbacks:flip-block,flip-inline,flip-block_flip-inline]"
          >
            {/* The grid inside, since a display of the dropdown's own would show it while closed. */}
            <div className="grid grid-cols-[auto_auto] items-center gap-x-6 gap-y-1">
              {settings.map((setting) => (
                <div key={setting.label} className="contents">
                  <span className="text-[11px] text-faint">{setting.label}</span>
                  <Control setting={setting} />
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Control({ setting }: { setting: Setting }) {
  return 'text' in setting ? (
    <span className="px-1 text-[11px] text-faint">{setting.text}</span>
  ) : (
    <Select
      label={setting.label}
      value={setting.value}
      options={setting.options}
      onChange={setting.onChange}
    />
  );
}

function shownText(setting: Setting): string {
  if ('text' in setting) return setting.text;
  return setting.options.find((option) => option.value === setting.value)?.label ?? setting.value;
}
