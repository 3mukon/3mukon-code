import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ndJsonStream, type Stream } from '@agentclientprotocol/sdk';

// A Grok Build agent process, spoken to over ACP on its standard input and output.
export interface GrokProcess {
  readonly stream: Stream;
  // Resolves once the process has ended: with nothing when stop ended it, else with what happened.
  readonly ended: Promise<string | undefined>;
  // Ends the process; resolves once it has exited.
  stop(): Promise<void>;
}

// Starts Grok Build with the arguments, in the folder.
export type StartGrok = (cwd: string, args: string[]) => Promise<GrokProcess>;

// Runs the binary with the app's environment. Its log output is drained and never kept, since Grok may
// print its settings there.
export function spawnGrok(binary: string, cwd: string, args: string[]): GrokProcess {
  const child = spawn(binary, args, { cwd, stdio: 'pipe' });
  child.stderr.resume();
  child.stdin.on('error', () => {
    // The process has gone; its exit reports it.
  });
  let stopping = false;
  const ended = new Promise<string | undefined>((resolve) => {
    child.once('error', (error) => {
      resolve(`Grok Build could not start: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      resolve(
        stopping
          ? undefined
          : `Grok Build stopped unexpectedly (${signal ?? `exit code ${String(code)}`}).`,
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
      stopping = true;
      child.stdin.end();
      child.kill();
      await ended;
    },
  };
}
