import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18n } from '../../i18n/renderer/i18n';
import type { Bridge } from '../shared/bridge';
import { App } from './app';
import './app.css';

declare global {
  interface Window {
    // Set by the preload script before the page loads.
    readonly bridge: Bridge;
  }
}

initI18n();

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <App bridge={window.bridge} />
  </StrictMode>,
);
