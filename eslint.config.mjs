import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    'out/',
    'dist/',
    'test-results/',
    'playwright-report/',
    // Generated from the bundled Codex binary by scripts/codex-protocol.mjs; not edited by hand.
    'src/providers/codex/main/protocol/',
  ]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['src/**/renderer/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      // What is dragged within the window drags with the pointer's own events, since a drag of the
      // system's shows Chromium's copy badge on macOS as it enters the page (docs/lessons/L-0003).
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='onDragStart']",
          message:
            'Drag within the window with the pointer’s own events, not a drag of the system’s (L-0003).',
        },
        {
          selector: "JSXAttribute[name.name='draggable']:not([value.expression.value=false])",
          message:
            'Drag within the window with the pointer’s own events, not a drag of the system’s (L-0003).',
        },
      ],
    },
  },
  {
    // A smoke test launches the app only through tests/smoke/app.ts, whose launchers lay a shield
    // over its windows that takes the Mac's own cursor, which would otherwise reach the page's
    // pointer while someone uses the Mac (docs/lessons/L-0004).
    files: ['tests/smoke/**/*.ts'],
    ignores: ['tests/smoke/app.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['@playwright/test', 'playwright', 'playwright-core'].map((name) => ({
            name,
            importNames: ['_electron'],
            message:
              'Launch the app with launch() or launchWith() from tests/smoke/app.ts, which shield its windows from the Mac’s own cursor (L-0004).',
          })),
        },
      ],
    },
  },
  {
    // Plain JavaScript files, such as this one, belong to no TypeScript project.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
