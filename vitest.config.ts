import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['src/**/*.test.ts'],
          // Live tests run only through vitest.live.config.ts.
          exclude: [...configDefaults.exclude, 'src/**/*.live.test.ts'],
          environment: 'node',
        },
      },
      // Component tests render into happy-dom's document.
      {
        extends: true,
        test: { name: 'dom', include: ['src/**/*.test.tsx'], environment: 'happy-dom' },
      },
    ],
  },
});
