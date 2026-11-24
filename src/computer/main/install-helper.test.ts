import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installHelper } from './install-helper';

const executable = 'Contents/MacOS/AutomationHelper';
let root: string;
let packaged: string;
let folder: string;
let installed: string;
const verify = vi.fn((bundle: string) => (bundle ? Promise.resolve() : Promise.reject(Error())));

async function write(bundle: string, file: string, text: string, mode = 0o644) {
  await mkdir(dirname(join(bundle, file)), { recursive: true });
  await writeFile(join(bundle, file), text);
  await chmod(join(bundle, file), mode);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), '3mukon-code-helper-'));
  packaged = join(root, 'app/Contents/Helpers/Computer Use Helper.app');
  folder = join(root, 'data');
  installed = join(folder, 'Computer Use Helper.app');
  await mkdir(folder);
  await write(packaged, executable, 'the first build', 0o755);
  await write(packaged, 'Contents/Info.plist', '<plist/>');
  verify.mockReset();
  verify.mockResolvedValue(undefined);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const install = () => installHelper(packaged, folder, verify);
const runs = () => readFile(join(installed, executable), 'utf8');

it('installs the packaged helper, whole and checked, beside the app’s data', async () => {
  expect(await install()).toBe(installed);
  expect(await runs()).toBe('the first build');
  expect((await lstat(join(installed, executable))).mode & 0o777).toBe(0o755);
  expect(verify.mock.calls).toEqual([[packaged], [installed]]);
  expect(await readdir(folder)).toEqual(['Computer Use Helper.app']);
});

it('leaves a helper of this build where it is, and checks it again', async () => {
  await install();
  const before = await lstat(join(installed, executable));
  verify.mockClear();
  expect(await install()).toBe(installed);
  expect((await lstat(join(installed, executable))).ino).toBe(before.ino);
  expect(verify.mock.calls).toEqual([[installed]]);
});

it.each<[string, () => Promise<void>]>([
  ['another build', () => write(packaged, executable, 'the next build!', 0o755)],
  ['a changed file', () => write(installed, executable, 'another program', 0o755)],
  ['a file that may not run', () => chmod(join(installed, executable), 0o644)],
  ['a missing file', () => rm(join(installed, 'Contents/Info.plist'))],
  ['an added file', () => write(installed, 'Contents/MacOS/other', 'added', 0o755)],
])('replaces a helper that differs by %s', async (_name, change) => {
  await install();
  await change();
  verify.mockClear();
  expect(await install()).toBe(installed);
  expect(await runs()).toBe(await readFile(join(packaged, executable), 'utf8'));
  expect((await readdir(installed, { recursive: true })).sort()).toEqual(
    (await readdir(packaged, { recursive: true })).sort(),
  );
  expect((await lstat(join(installed, executable))).mode & 0o777).toBe(0o755);
  expect(verify.mock.calls).toEqual([[packaged], [installed]]);
  expect(await readdir(folder)).toEqual(['Computer Use Helper.app']);
});

it('replaces a link that stands in its place, and follows none', async () => {
  const elsewhere = join(root, 'elsewhere.app');
  await write(elsewhere, executable, 'the first build', 0o755);
  await write(elsewhere, 'Contents/Info.plist', '<plist/>');
  await symlink(elsewhere, installed);
  await install();
  expect((await lstat(installed)).isDirectory()).toBe(true);
  expect(await runs()).toBe('the first build');

  await rm(join(installed, executable));
  await symlink(join(elsewhere, executable), join(installed, executable));
  await install();
  expect((await lstat(join(installed, executable))).isFile()).toBe(true);
});

it('removes what an install that was cut short left', async () => {
  await write(join(folder, 'Computer Use Helper.1'), executable, 'half');
  await mkdir(join(folder, 'coordination'));
  await install();
  expect((await readdir(folder)).sort()).toEqual(['Computer Use Helper.app', 'coordination']);
});

// A thin 64-bit Mach-O executable whose one load command points at its code signature.
function signed(code: string, signature: string): Buffer {
  const body = Buffer.from(code);
  const seal = Buffer.from(signature);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(1, 16);
  header.writeUInt32LE(16, 20);
  const command = Buffer.alloc(16);
  command.writeUInt32LE(0x1d, 0);
  command.writeUInt32LE(16, 4);
  command.writeUInt32LE(48 + body.length, 8);
  command.writeUInt32LE(seal.length, 12);
  return Buffer.concat([header, command, body, seal]);
}

async function writeSigned(bundle: string, code: string, signature: string) {
  await writeFile(join(bundle, executable), signed(code, signature));
  await chmod(join(bundle, executable), 0o755);
}

it('compares signed executables by their signatures alone, leaving the rest to the check', async () => {
  await writeSigned(packaged, 'the first build', 'signature one');
  await install();
  const before = await lstat(join(installed, executable));
  // The same signature over other code: only the check can tell, so the copy stays where it passes.
  await writeSigned(installed, 'the other build', 'signature one');
  verify.mockClear();
  expect(await install()).toBe(installed);
  expect((await lstat(join(installed, executable))).ino).toBe(before.ino);
  expect(verify.mock.calls).toEqual([[installed]]);
});

it('replaces a copy whose signature differs, and a copy of the same signature that fails its check', async () => {
  await writeSigned(packaged, 'the first build', 'signature one');
  await install();
  await writeSigned(packaged, 'the first build', 'signature two');
  verify.mockClear();
  await install();
  expect(await readFile(join(installed, executable))).toEqual(
    signed('the first build', 'signature two'),
  );
  expect(verify.mock.calls).toEqual([[packaged], [installed]]);

  await writeSigned(installed, 'the other build', 'signature two');
  const changed = await readFile(join(installed, executable));
  verify.mockReset();
  verify.mockImplementation(async (bundle) => {
    const code = await readFile(join(bundle, executable));
    if (code.equals(changed)) throw new Error('changed after its install');
  });
  await install();
  expect(await readFile(join(installed, executable))).toEqual(
    signed('the first build', 'signature two'),
  );
  expect(verify.mock.calls).toEqual([[installed], [packaged], [installed]]);
});

it('installs nothing that fails its check, and runs nothing that does', async () => {
  await install();
  await write(packaged, executable, 'not the app’s', 0o755);
  verify.mockRejectedValueOnce(new Error('signature'));
  await expect(install()).rejects.toThrow('signature');
  expect(await runs()).toBe('the first build');

  await write(packaged, executable, 'the next build', 0o755);
  verify.mockReset();
  verify.mockImplementation((bundle) =>
    bundle === installed ? Promise.reject(new Error('copy')) : Promise.resolve(),
  );
  await expect(install()).rejects.toThrow('copy');
});
