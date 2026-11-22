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
      name: 'sessions-only-to-ui-and-i18n',
      comment:
        'The sessions module uses only the ui and i18n modules; the app module hands it the providers and the folders (src/sessions/README.md).',
      severity: 'error',
      from: { path: '^src/sessions/' },
      to: { path: '^src/', pathNot: ['^src/sessions/', '^src/ui/', '^src/i18n/'] },
    },
    {
      name: 'workspaces-only-to-ui-and-i18n',
      comment:
        'The workspaces module uses only the ui and i18n modules (src/workspaces/README.md).',
      severity: 'error',
      from: { path: '^src/workspaces/' },
      to: { path: '^src/', pathNot: ['^src/workspaces/', '^src/ui/', '^src/i18n/'] },
    },
    {
      name: 'approvals-only-to-sessions-ui-and-i18n',
      comment:
        "The approvals module answers the sessions' requests: it uses the sessions module's model and its activity's views, the ui and i18n modules, and the sessions module never uses it (src/approvals/README.md).",
      severity: 'error',
      from: { path: '^src/approvals/' },
      to: {
        path: '^src/',
        pathNot: ['^src/approvals/', '^src/sessions/(shared|renderer)/', '^src/ui/', '^src/i18n/'],
      },
    },
    {
      name: 'files-only-to-ui-and-i18n',
      comment: 'The files module uses only the ui and i18n modules (src/files/README.md).',
      severity: 'error',
      from: { path: '^src/files/' },
      to: { path: '^src/', pathNot: ['^src/files/', '^src/ui/', '^src/i18n/'] },
    },
    {
      name: 'settings-only-to-ui-and-i18n',
      comment: 'The settings module uses only the ui and i18n modules (src/settings/README.md).',
      severity: 'error',
      from: { path: '^src/settings/' },
      to: { path: '^src/', pathNot: ['^src/settings/', '^src/ui/', '^src/i18n/'] },
    },
    {
      name: 'panels-only-to-ui-and-i18n',
      comment: 'The panels module uses only the ui and i18n modules (src/panels/README.md).',
      severity: 'error',
      from: { path: '^src/panels/' },
      to: {
        path: '^src/',
        pathNot: [
          '^src/panels/',
          '^src/ui/',
          '^src/i18n/',
          '^src/sessions/shared/automation\\.ts$',
        ],
      },
    },
    {
      name: 'terminal-only-to-ui-and-i18n',
      comment: 'The terminal module uses only the ui and i18n modules (src/terminal/README.md).',
      severity: 'error',
      from: { path: '^src/terminal/' },
      to: { path: '^src/', pathNot: ['^src/terminal/', '^src/ui/', '^src/i18n/'] },
    },
    {
      name: 'accounts-only-to-sessions-model-ui-and-i18n',
      comment:
        "The accounts module names the providers by the sessions module's model and uses the ui and i18n modules; the app module hands it the adapters (src/accounts/README.md).",
      severity: 'error',
      from: { path: '^src/accounts/' },
      to: {
        path: '^src/',
        pathNot: ['^src/accounts/', '^src/sessions/shared/', '^src/ui/', '^src/i18n/'],
      },
    },
    {
      name: 'providers-only-to-sessions-and-accounts-contracts',
      comment:
        'A provider adapter uses only the sessions interface and model and the accounts interface and model, never other modules or UI code (src/providers/claude-code/README.md).',
      severity: 'error',
      from: { path: '^src/providers/', pathNot: '\\.live\\.test\\.ts$' },
      to: {
        path: '^src/',
        pathNot: [
          '^src/providers/',
          '^src/sessions/main/provider\\.ts$',
          '^src/sessions/shared/',
          '^src/accounts/main/source\\.ts$',
          '^src/accounts/shared/',
        ],
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
          '^src/accounts/main/source\\.ts$',
          '^src/accounts/shared/',
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
        pathNot: [
          '^src/toolset/',
          '^src/sessions/main/provider\\.ts$',
          '^src/sessions/shared/',
          '^src/panels/shared/presentation(-host)?\\.ts$',
        ],
      },
    },
    {
      name: 'browser-and-computer-use-shared-session-facts',
      comment: 'App composition connects automation backends to the broker and the panel area.',
      severity: 'error',
      from: { path: '^src/(browser|computer)/' },
      to: {
        path: '^src/',
        pathNot: ['^src/$1/', '^src/sessions/shared/', '^src/ui/', '^src/i18n/'],
      },
    },
    {
      name: 'automation-feature-contracts-are-types',
      comment:
        'App composition supplies feature implementations and constants; these edges carry types only.',
      severity: 'error',
      from: { path: '^src/toolset/' },
      to: { path: '^src/panels/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'panels-session-facts-are-types',
      severity: 'error',
      from: { path: '^src/panels/' },
      to: { path: '^src/sessions/', dependencyTypesNot: ['type-only'] },
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
    {
      name: 'preload-only-to-shared-and-electron',
      comment:
        "The preload script runs in the sandboxed page before it loads, as one file; it uses Electron and the shared/ parts' types and channels, never main-process or UI code, Node.js built-ins or other packages (src/app/README.md).",
      severity: 'error',
      from: { path: '^src/.+/preload/', pathNot: '\\.test\\.ts$' },
      to: { pathNot: ['^src/.+/(shared|preload)/', 'node_modules/electron/'] },
    },
    {
      name: 'nothing-imports-the-preload-script',
      comment:
        'The preload script is an entry point of its own, which Electron loads into the page.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/.+/preload/' },
      to: { path: '^src/.+/preload/' },
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
