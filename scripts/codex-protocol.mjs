/* global console */
// Regenerates the Codex app-server protocol types that the codex provider uses, from the bundled Codex
// binary (ADR-0003). Every type is generated into a temporary folder; the ones named in ROOTS, with
// everything they import, are copied into src/providers/codex/main/protocol/ and formatted. Run it
// after each upgrade of @openai/codex: corepack pnpm run codex:protocol
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// The types the adapter names; the rest of the protocol, such as sign-in and accounts, stays out.
const ROOTS = [
  'InitializeParams',
  'InitializeResponse',
  'RequestId',
  'v2/ThreadStartParams',
  'v2/ThreadStartResponse',
  'v2/ThreadResumeParams',
  'v2/ThreadResumeResponse',
  'v2/ThreadListParams',
  'v2/ThreadListResponse',
  'v2/ThreadReadParams',
  'v2/ThreadReadResponse',
  'v2/ThreadTurnsListParams',
  'v2/ThreadTurnsListResponse',
  'v2/TurnStartParams',
  'v2/TurnStartResponse',
  'v2/TurnSteerParams',
  'v2/TurnSteerResponse',
  'v2/TurnInterruptParams',
  'v2/ModelListParams',
  'v2/ModelListResponse',
  'v2/CommandExecutionRequestApprovalParams',
  'v2/CommandExecutionRequestApprovalResponse',
  'v2/FileChangeRequestApprovalParams',
  'v2/FileChangeRequestApprovalResponse',
  'v2/PermissionsRequestApprovalParams',
  'v2/PermissionsRequestApprovalResponse',
  'v2/ToolRequestUserInputParams',
  'v2/ToolRequestUserInputResponse',
  'v2/McpServerElicitationRequestResponse',
  'v2/ItemStartedNotification',
  'v2/ItemCompletedNotification',
  'v2/AgentMessageDeltaNotification',
  'v2/ReasoningSummaryTextDeltaNotification',
  'v2/ReasoningTextDeltaNotification',
  'v2/CommandExecutionOutputDeltaNotification',
  'v2/FileChangePatchUpdatedNotification',
  'v2/TurnCompletedNotification',
  'v2/TurnPlanUpdatedNotification',
  'v2/ThreadNameUpdatedNotification',
  'v2/ThreadTokenUsageUpdatedNotification',
  'v2/ErrorNotification',
  'v2/ServerRequestResolvedNotification',
  'v2/ItemGuardianApprovalReviewCompletedNotification',
  'v2/ModelReroutedNotification',
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'src/providers/codex/main/protocol');
const fromRoot = createRequire(join(root, 'package.json'));
const codexPackage = fromRoot.resolve('@openai/codex/package.json');
const nativePackage = createRequire(codexPackage).resolve(
  '@openai/codex-darwin-arm64/package.json',
);
const binary = join(dirname(nativePackage), 'vendor', 'aarch64-apple-darwin', 'bin', 'codex');

const generated = mkdtempSync(join(tmpdir(), 'codex-protocol-'));
try {
  execFileSync(binary, ['app-server', 'generate-ts', '--out', generated], { stdio: 'inherit' });
  const types = new Set();
  const visit = (name) => {
    const key = normalize(name);
    if (types.has(key)) return;
    const file = join(generated, `${key}.ts`);
    if (!existsSync(file)) throw new Error(`Codex generated no type ${key}.`);
    types.add(key);
    for (const [, from] of readFileSync(file, 'utf8').matchAll(/from\s+"([^"]+)"/g)) {
      visit(join(dirname(key), from));
    }
  };
  ROOTS.forEach(visit);
  rmSync(target, { recursive: true, force: true });
  for (const key of types) {
    mkdirSync(join(target, dirname(key)), { recursive: true });
    cpSync(join(generated, `${key}.ts`), join(target, `${key}.ts`));
  }
  execFileSync(
    join(root, 'node_modules', '.bin', 'prettier'),
    ['--write', '--log-level', 'warn', target],
    {
      stdio: 'inherit',
    },
  );
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`codex protocol: ${types.size} types from ${version}`);
} finally {
  rmSync(generated, { recursive: true, force: true });
}
