import { readFile, stat, writeFile } from 'node:fs/promises';
import { MAX_EDITABLE_BYTES, type OpenedFile, type SaveResult } from '../shared/files';

// A file's text, read as UTF-8: a file of no more than MAX_EDITABLE_BYTES, without a NUL byte and of
// valid UTF-8, counts as text, and a byte order mark it starts with is left out and noted. Anything
// else opens as a notice: a file larger than that, one of other bytes, one that is missing, and one
// that cannot be read or is no file, such as a folder.
export async function readText(path: string): Promise<OpenedFile> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return notice('unreadable');
    if (info.size > MAX_EDITABLE_BYTES) return notice('too-large');
    const bytes = await readFile(path);
    // The file may have grown since it was measured.
    if (bytes.length > MAX_EDITABLE_BYTES) return notice('too-large');
    return decoded(bytes) ?? notice('binary');
  } catch (error) {
    return notice(codeOf(error) === 'ENOENT' ? 'missing' : 'unreadable');
  }
}

// Writes the text as UTF-8 over what the file holds, through the file itself, so that a link keeps
// pointing to it and the file keeps its permissions; a missing file is created in its folder.
export async function writeText(path: string, text: string): Promise<SaveResult> {
  try {
    await writeFile(path, text, 'utf8');
    return { saved: true };
  } catch (error) {
    const code = codeOf(error);
    return { saved: false, reason: code === 'EACCES' || code === 'EPERM' ? 'denied' : 'failed' };
  }
}

function decoded(bytes: Buffer): OpenedFile | undefined {
  if (bytes.includes(0)) return undefined;
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bom ? bytes.subarray(3) : bytes,
    );
    return { kind: 'text', text, bom };
  } catch {
    return undefined;
  }
}

function notice(why: Extract<OpenedFile, { kind: 'notice' }>['notice']): OpenedFile {
  return { kind: 'notice', notice: why };
}

function codeOf(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}
