import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// The entry points live in the app module, not in electron-vite's default src/main, src/preload and
// src/renderer.
const app = resolve(import.meta.dirname, 'src/app');

export default defineConfig({
  main: {
    build: { lib: { entry: resolve(app, 'main/index.ts') } },
  },
  // A sandboxed page's preload script runs as one CommonJS file.
  preload: {
    build: {
      lib: {
        entry: {
          index: resolve(app, 'preload/index.ts'),
          'control-window': resolve(app, 'preload/control-window.ts'),
        },
        formats: ['cjs'],
      },
      rolldownOptions: { output: { entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    root: resolve(app, 'renderer'),
    build: {
      rolldownOptions: {
        input: {
          index: resolve(app, 'renderer/index.html'),
          'control-window': resolve(app, 'renderer/control-window.html'),
        },
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
