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
      name: 'icons-only-through-ui',
      comment:
        'Icons come from Lucide through the ui module, so the app keeps one icon set (src/ui/README.md, ADR-0007).',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/ui/' },
      to: { path: 'node_modules/lucide-react/' },
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
      name: 'sessions-not-to-providers',
      comment:
        'Provider adapters implement the sessions interface; sessions never imports them (src/sessions/README.md).',
      severity: 'error',
      from: { path: '^src/sessions/' },
      to: { path: '^src/providers/' },
    },
    {
      name: 'providers-only-to-sessions-contract',
      comment:
        'A provider adapter uses only the sessions interface and model, never other modules or UI code (src/providers/claude-code/README.md).',
      severity: 'error',
      from: { path: '^src/providers/', pathNot: '\\.live\\.test\\.ts$' },
      to: {
        path: '^src/',
        pathNot: ['^src/providers/', '^src/sessions/main/provider\\.ts$', '^src/sessions/shared/'],
      },
    },
    {
      name: 'provider-live-tests-compose-as-the-app',
      comment:
        "An adapter's live test may also start the toolset, as the app module does, and nothing else (src/toolset/README.md).",
      severity: 'error',
      from: { path: '^src/providers/.+\\.live\\.test\\.ts$' },
      to: {
        path: '^src/',
        pathNot: [
          '^src/providers/',
          '^src/sessions/main/provider\\.ts$',
          '^src/sessions/shared/',
          '^src/toolset/main/server\\.ts$',
        ],
      },
    },
    {
      name: 'toolset-only-to-sessions-contract',
      comment:
        'The toolset uses only the sessions interface and model, never a provider adapter or UI code (src/toolset/README.md).',
      severity: 'error',
      from: { path: '^src/toolset/' },
      to: {
        path: '^src/',
        pathNot: ['^src/toolset/', '^src/sessions/main/provider\\.ts$', '^src/sessions/shared/'],
      },
    },
    {
      name: 'toolset-only-from-app',
      comment:
        'The app module starts the toolset and hands it to the adapters through the sessions interface (src/toolset/README.md, ADR-0009).',
      severity: 'error',
      from: {
        path: '^src/',
        pathNot: ['^src/app/', '^src/toolset/', '^src/providers/.+\\.live\\.test\\.ts$'],
      },
      to: { path: '^src/toolset/' },
    },
    {
      name: 'providers-not-to-each-other',
      comment: 'Each provider adapter stands alone.',
      severity: 'error',
      from: { path: '^src/providers/([^/]+)/' },
      to: { path: '^src/providers/', pathNot: '^src/providers/$1/' },
    },
    {
      name: 'shared-not-to-process-code',
      comment:
        "A module's shared/ code runs in the main process and the renderer alike, so it imports neither side's code.",
      severity: 'error',
      from: { path: '^src/.+/shared/' },
      to: { path: '^src/.+/(main|renderer)/' },
    },
    {
      name: 'shared-not-to-node',
      comment: 'shared/ code also runs in the sandboxed page, which has no Node.js built-ins.',
      severity: 'error',
      from: { path: '^src/.+/shared/' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'shared-not-to-electron',
      comment:
        "shared/ code also runs in the sandboxed page, where Electron's modules do not exist.",
      severity: 'error',
      from: { path: '^src/.+/shared/' },
      to: { path: 'node_modules/electron/' },
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
    // Packages are resolved through their export maps, as Node.js and the bundler resolve them, so that
    // subpath imports such as the MCP SDK's resolve.
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    // Type-only imports count too: a type from main-process code would pull Node.js types into the page.
    tsPreCompilationDeps: true,
  },
};
