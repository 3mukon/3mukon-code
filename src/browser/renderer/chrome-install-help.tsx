import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/renderer/button';

// The first load of the app's extension in Chrome, while a connection waits for it: what to do in the
// setup tab's window, with Copy Folder Path for Load unpacked's folder. Settings draws it under
// Chrome's item, in step with the item's words; a session's notice in its own type.
export function ChromeInstallHelp({
  folder,
  copyFolder,
  className,
}: {
  folder: string;
  copyFolder: (path: string) => Promise<void>;
  className: string;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  return (
    <div className={`flex flex-col items-start gap-1.5 text-muted ${className}`}>
      <p>{t('browser.chrome.loadExtension')}</p>
      <div className="flex items-baseline gap-2">
        <Button
          label={t('browser.chrome.copyExtensionFolder')}
          onClick={() => {
            void copyFolder(folder).then(
              () => {
                setCopied('copied');
              },
              () => {
                setCopied('failed');
              },
            );
          }}
        />
        <span role="status" className={copied === 'failed' ? 'text-del' : ''}>
          {copied === 'copied'
            ? t('browser.chrome.folderCopied')
            : copied === 'failed'
              ? t('browser.failed')
              : ''}
        </span>
      </div>
    </div>
  );
}
