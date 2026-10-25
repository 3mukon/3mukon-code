import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// The entry points live in the app module, not in electron-vite's default src/main and src/renderer.
// There is no preload script until the renderer first needs the main process, so the build warns
// that the preload config is missing.
const app = resolve(import.meta.dirname, 'src/app');

export default defineConfig({
  main: {
    build: { lib: { entry: resolve(app, 'main/index.ts') } },
  },
  renderer: {
    root: resolve(app, 'renderer'),
    build: { rolldownOptions: { input: resolve(app, 'renderer/index.html') } },
    plugins: [react()],
  },
});
