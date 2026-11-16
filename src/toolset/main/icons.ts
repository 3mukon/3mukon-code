import { createHash } from 'node:crypto';
import { crc32, inflateSync } from 'node:zlib';
import type { MessageImage } from '../../sessions/shared/events';
import type { Outcome } from '../../sessions/shared/automation';
import { AUTOMATION_ICON_LIMITS as LIMITS } from '../../sessions/shared/automation';

// Bytes are stored once by content, even across owners. Possessing an ID is not permission to read
// it: each read also needs a retained fact of that session to name it.
export class Icons {
  private readonly entries = new Map<string, { image: MessageImage; owners: Set<string> }>();
  private readonly owned = new Map<string, Set<string>>();

  add(
    owner: string,
    image: MessageImage | undefined,
    retained: ReadonlySet<string>,
  ): string | undefined {
    this.retain(owner, retained);
    const bytes = checkedPng(image);
    if (!bytes || !image) return undefined;
    const id = `icon:${createHash('sha256').update(bytes).digest('hex')}`;
    const own = this.owned.get(owner) ?? new Set<string>();
    if (own.has(id)) return id;
    if (own.size >= LIMITS.perSession) return undefined;
    own.add(id);
    this.owned.set(owner, own);
    const entry = this.entries.get(id) ?? {
      image: { mediaType: LIMITS.mediaType, data: image.data },
      owners: new Set<string>(),
    };
    entry.owners.add(owner);
    this.entries.set(id, entry);
    return id;
  }

  read(owner: string, id: string, retained: ReadonlySet<string>): Outcome<MessageImage> {
    this.retain(owner, retained);
    const entry = this.entries.get(id);
    if (!retained.has(id) || !entry?.owners.has(owner))
      return { status: 'refused', code: 'not-found', dispatched: false };
    return { status: 'verified', value: { ...entry.image } };
  }

  release(owner: string): void {
    this.retain(owner, new Set());
  }

  private retain(owner: string, retained: ReadonlySet<string>): void {
    const own = this.owned.get(owner);
    if (!own) return;
    for (const id of own) {
      if (retained.has(id)) continue;
      own.delete(id);
      const entry = this.entries.get(id);
      entry?.owners.delete(owner);
      if (entry?.owners.size === 0) this.entries.delete(id);
    }
    if (own.size === 0) this.owned.delete(owner);
  }
}

// Validate bounded PNG bytes before they reach storage or a renderer: the actual IHDR dimensions,
// chunk framing/checksums and bounded scanline data, not caller-supplied width/height metadata.
function checkedPng(image: MessageImage | undefined): Buffer | undefined {
  if (
    image?.mediaType !== LIMITS.mediaType ||
    typeof image.data !== 'string' ||
    image.data.length > Math.ceil(LIMITS.decodedBytes / 3) * 4 ||
    image.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
  )
    return undefined;
  const bytes = Buffer.from(image.data, 'base64');
  if (
    bytes.length > LIMITS.decodedBytes ||
    bytes.length < 45 ||
    bytes.toString('base64') !== image.data ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('latin1', 12, 16) !== 'IHDR'
  )
    return undefined;
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  const depth = bytes[24] ?? 0,
    color = bytes[25] ?? -1;
  const depths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    width < 1 ||
    height < 1 ||
    width > LIMITS.edge ||
    height > LIMITS.edge ||
    !depths[color]?.includes(depth) ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    (bytes[28] !== 0 && bytes[28] !== 1)
  )
    return undefined;
  const chunks: Buffer[] = [];
  let ended = false,
    palette = false,
    dataEnded = false;
  for (let at = 8; at < bytes.length;) {
    if (at + 12 > bytes.length) return undefined;
    const length = bytes.readUInt32BE(at),
      end = at + 12 + length;
    if (end > bytes.length) return undefined;
    const kind = bytes.toString('latin1', at + 4, at + 8);
    if (
      !/^[A-Za-z]{4}$/.test(kind) ||
      crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
    )
      return undefined;
    if (kind === 'IHDR' && at !== 8) return undefined;
    if (kind === 'PLTE') {
      if (
        palette ||
        chunks.length ||
        color === 0 ||
        color === 4 ||
        length === 0 ||
        length > 768 ||
        length % 3 !== 0 ||
        (color === 3 && length / 3 > 2 ** depth)
      )
        return undefined;
      palette = true;
    } else if (kind === 'IDAT') {
      if (dataEnded || (color === 3 && !palette)) return undefined;
      chunks.push(bytes.subarray(at + 8, end - 4));
    } else {
      if (chunks.length) dataEnded = true;
      if (kind === 'IEND') {
        if (length !== 0 || end !== bytes.length) return undefined;
        ended = true;
      } else if (kind !== 'IHDR' && /^[A-Z]/.test(kind)) return undefined;
    }
    at = end;
  }
  if (!ended || chunks.length === 0 || (color === 3 && !palette)) return undefined;
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bits = (channels[color] ?? 0) * depth;
  const passes =
    bytes[28] === 0
      ? [[0, 0, 1, 1]]
      : [
          [0, 0, 8, 8],
          [4, 0, 8, 8],
          [0, 4, 4, 8],
          [2, 0, 4, 4],
          [0, 2, 2, 4],
          [1, 0, 2, 2],
          [0, 1, 1, 2],
        ];
  const rows: number[] = [];
  for (const [x = 0, y = 0, dx = 1, dy = 1] of passes) {
    const columns = Math.max(0, Math.ceil((width - x) / dx));
    const count = Math.max(0, Math.ceil((height - y) / dy));
    if (columns)
      for (let row = 0; row < count; row++) rows.push(1 + Math.ceil((columns * bits) / 8));
  }
  const expected = rows.reduce((sum, row) => sum + row, 0);
  try {
    const pixels = inflateSync(Buffer.concat(chunks), { maxOutputLength: expected + 1 });
    if (pixels.length !== expected) return undefined;
    let at = 0;
    for (const length of rows) {
      if ((pixels[at] ?? 255) > 4) return undefined;
      at += length;
    }
  } catch {
    return undefined;
  }
  return bytes;
}
