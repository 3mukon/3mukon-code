// Module rules: the dependency directions the module READMEs declare, and the boundary between the
// main process and the renderer. A new module adds its rules here in the same change as its README.
/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Code in a cycle cannot be understood or changed one module at a time.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-undeclared-packages',
      comment: 'Every package the code imports is declared in package.json.',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'app-is-the-entry',
      comment:
        'The app module composes the others, and no other module imports it (src/app/README.md).',
      severity: 'error',
      from: { pathNot: '^src/app/' },
      to: { path: '^src/app/' },
    },
    {
      name: 'ui-imports-no-module',
      comment:
        'ui holds the design tokens and presentational components; every module may use it, and it uses none (src/ui/README.md).',
      severity: 'error',
      from: { path: '^src/ui/' },
      to: { path: '^src/', pathNot: '^src/ui/' },
    },
    {
      name: 'i18n-imports-no-module',
      comment:
        'i18n holds the catalogs and the localization runtime; every module may use it, and it uses none (src/i18n/README.md).',
      severity: 'error',
      from: { path: '^src/i18n/' },
      to: { path: '^src/', pathNot: '^src/i18n/' },
    },
    {
      name: 'renderer-not-to-main',
      comment:
        'Renderer code runs in the sandboxed page and reaches the main process only through the preload bridge.',
      severity: 'error',
      from: { path: '^src/.+/renderer/' },
      to: { path: '^src/.+/main/' },
    },
    {
      name: 'renderer-not-to-node',
      comment: 'The sandboxed page has no Node.js built-ins.',
      severity: 'error',
      from: { path: '^src/.+/renderer/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'renderer-not-to-electron',
      comment: "Electron's main-process modules do not exist in the sandboxed page.",
      severity: 'error',
      from: { path: '^src/.+/renderer/' },
      to: { path: 'node_modules/electron/' },
    },
    {
      name: 'main-not-to-renderer',
      comment: 'Main-process code never imports UI code.',
      severity: 'error',
      from: { path: '^src/.+/main/' },
      to: { path: '^src/.+/renderer/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Type-only imports count too: a type from main-process code would pull Node.js types into the page.
    tsPreCompilationDeps: true,
  },
};
