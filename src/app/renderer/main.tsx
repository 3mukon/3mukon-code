import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initI18n } from '../../i18n/renderer/i18n';
import { App } from './app';
import './app.css';

initI18n();

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
