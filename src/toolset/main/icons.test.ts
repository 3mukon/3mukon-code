import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { MessageImage } from '../../sessions/shared/events';
import { AUTOMATION_ICON_LIMITS } from '../../sessions/shared/automation';
import { Icons } from './icons';

function chunk(kind: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(kind), data]);
  const size = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, checksum]);
}
function png(seed = 0, width = 1, height = 1, extraBytes = 0): MessageImage {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  pixels[1] = seed & 255;
  pixels[2] = seed >> 8;
  pixels[4] = 255;
  return {
    mediaType: 'image/png',
    data: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', header),
      ...(extraBytes ? [chunk('tEXt', Buffer.alloc(extraBytes, 65))] : []),
      chunk('IDAT', deflateSync(pixels)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64'),
  };
}
function required(value: string | undefined): string {
  if (!value) throw new Error('Missing fixture icon.');
  return value;
}

describe('bounded target icons', () => {
  it('checks PNG signature, actual dimensions, byte size, checksums and scanline data', () => {
    const icons = new Icons(),
      retained = new Set<string>();
    const valid = png();
    expect(icons.add('a', valid, retained)).toBeDefined();
    expect(icons.add('a', png(0, 128, 128), retained)).toBeDefined();
    expect(icons.add('a', png(0, 129, 1), retained)).toBeUndefined();
    expect(icons.add('a', png(0, 1, 129), retained)).toBeUndefined();
    expect(
      icons.add('a', png(0, 1, 1, AUTOMATION_ICON_LIMITS.decodedBytes), retained),
    ).toBeUndefined();
    expect(icons.add('a', { ...valid, mediaType: 'image/jpeg' }, retained)).toBeUndefined();
    expect(icons.add('a', { ...valid, data: 'AAAA' }, retained)).toBeUndefined();
    const corrupt = Buffer.from(valid.data, 'base64');
    corrupt[29] = (corrupt[29] ?? 0) ^ 1;
    expect(
      icons.add('a', { ...valid, data: corrupt.toString('base64') }, retained),
    ).toBeUndefined();
    expect(
      icons.add(
        'a',
        { ...valid, data: Buffer.from(valid.data, 'base64').subarray(0, 33).toString('base64') },
        retained,
      ),
    ).toBeUndefined();
  });
  it('stores repeated bytes once, bounds distinct icons, and reclaims those no retained fact names', () => {
    const icons = new Icons(),
      retained = new Set<string>();
    const first = required(icons.add('a', png(), retained));
    retained.add(first);
    for (let index = 0; index < 300; index++) expect(icons.add('a', png(), retained)).toBe(first);
    for (let index = 1; index < AUTOMATION_ICON_LIMITS.perSession; index++)
      retained.add(required(icons.add('a', png(index), retained)));
    expect(icons.add('a', png(1000), retained)).toBeUndefined();
    retained.delete(first);
    expect(icons.read('a', first, retained)).toMatchObject({ code: 'not-found' });
    expect(icons.add('a', png(1000), retained)).toBeDefined();
  });
  it('does not turn a content hash or another session retaining it into read permission', () => {
    const icons = new Icons();
    const id = required(icons.add('a', png(), new Set()));
    expect(icons.read('b', id, new Set())).toMatchObject({ code: 'not-found' });
    expect(icons.add('b', png(), new Set())).toBe(id);
    icons.release('a');
    expect(icons.read('a', id, new Set())).toMatchObject({ code: 'not-found' });
    expect(icons.read('b', id, new Set([id]))).toEqual({ status: 'verified', value: png() });
  });
});
