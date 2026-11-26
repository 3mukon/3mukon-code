import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk';

// An Antigravity process running `agy acp`, spoken to over ACP on its standard input and output.
export interface AgyProcess {
  readonly stream: Stream;
  // Resolves once the process has ended: with nothing when stop ended it, else with what happened.
  readonly ended: Promise<string | undefined>;
  // Ends the process; resolves once it has exited. Called again, it only waits.
  stop(): Promise<void>;
}

// Starts Antigravity with the arguments, in the folder.
export type StartAgy = (cwd: string, args: string[]) => Promise<AgyProcess>;

// How long a process may take to end once its input closes before it is ended outright: agy's front
// process ends the worker that serves its session first.
const STOP_GRACE_MS = 3_000;

// Runs the binary with the app's environment and the variables given, such as the updater's switch for
// the app's own copy. Its log output is drained and never kept; agy writes its own log in its settings
// folder, as it does for the user's own runs.
export function spawnAgy(
  binary: string,
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): AgyProcess {
  const child = spawn(binary, args, { cwd, stdio: 'pipe', env: { ...process.env, ...env } });
  child.stderr.resume();
  child.stdin.on('error', () => {
    // The process has gone; its exit reports it.
  });
  let stopping = false;
  let exited = false;
  const ended = new Promise<string | undefined>((resolve) => {
    child.once('error', (error) => {
      resolve(`Antigravity could not start: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      exited = true;
      resolve(
        stopping
          ? undefined
          : `Antigravity stopped unexpectedly (${signal ?? `exit code ${String(code)}`}).`,
      );
    });
  });
  return {
    stream: ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    ),
    ended,
    async stop() {
      if (!stopping) {
        stopping = true;
        child.stdin.end();
        const timer = setTimeout(() => {
          if (!exited) child.kill();
        }, STOP_GRACE_MS);
        void ended.then(() => {
          clearTimeout(timer);
        });
      }
      await ended;
    },
  };
}
