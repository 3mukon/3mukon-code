import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18n } from '../../i18n/renderer/i18n';
import { preferredLanguages } from '../../settings/shared/settings';
import type { Bridge } from '../shared/bridge';
import { App } from './app';
import './app.css';

declare global {
  interface Window {
    // Set by the preload script before the page loads.
    readonly bridge: Bridge;
  }
}

// In the language the settings choose, which may be macOS's.
initI18n(preferredLanguages(window.bridge.settings.initial.language, navigator.languages));

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <App bridge={window.bridge} />
  </StrictMode>,
);
