import { randomUUID } from 'node:crypto';
import { artifactWithinLimits, type Artifact } from '../shared/presentation';

export const ARTIFACT_STORE_LIMITS = {
  ownerBytes: 32 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  entries: 512,
} as const;
interface Entry {
  owner: string;
  value: Artifact;
  bytes: number;
}

export class Artifacts {
  private readonly entries = new Map<string, Entry>();
  put(
    owner: string,
    artifact: Artifact,
  ): { id: string } | { code: 'invalid-request' | 'limit-exceeded' } {
    if (!artifactWithinLimits(artifact) || (artifact.format === 'image' && !validImage(artifact)))
      return { code: 'invalid-request' };
    const bytes = Buffer.byteLength(JSON.stringify(artifact));
    const entries = [...this.entries.values()];
    if (
      entries.length >= ARTIFACT_STORE_LIMITS.entries ||
      entries.reduce((n, e) => n + e.bytes, bytes) > ARTIFACT_STORE_LIMITS.totalBytes ||
      entries.filter((e) => e.owner === owner).reduce((n, e) => n + e.bytes, bytes) >
        ARTIFACT_STORE_LIMITS.ownerBytes
    )
      return { code: 'limit-exceeded' };
    const id = randomUUID();
    this.entries.set(id, {
      owner,
      value: structuredClone(artifact),
      bytes,
    });
    return { id };
  }
  get(owner: string, id: string): Artifact | null {
    const entry = this.entries.get(id);
    return entry?.owner === owner ? structuredClone(entry.value) : null;
  }
  has(owner: string, id: string): boolean {
    return this.entries.get(id)?.owner === owner;
  }
  retain(ids: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id);
  }
  removeOwner(owner: string): void {
    for (const [id, entry] of this.entries) if (entry.owner === owner) this.entries.delete(id);
  }
}

// Read encoded dimensions; a declared 1x1 image cannot smuggle a huge canvas into the renderer.
function validImage(image: Extract<Artifact, { format: 'image' }>): boolean {
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.toString('base64') !== image.data) return false;
  let dimensions: [number, number] | undefined;
  if (
    image.mediaType === 'image/png' &&
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR'
  )
    dimensions = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (
    image.mediaType === 'image/gif' &&
    bytes.length >= 13 &&
    ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
  )
    dimensions = [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
  if (
    image.mediaType === 'image/webp' &&
    bytes.length >= 30 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const type = bytes.toString('ascii', 12, 16);
    if (type === 'VP8X') dimensions = [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    if (type === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42])))
      dimensions = [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    if (type === 'VP8L' && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21);
      dimensions = [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
  }
  if (image.mediaType === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216) {
    let at = 2;
    while (at + 4 <= bytes.length && bytes[at] === 255) {
      while (bytes[at] === 255) at++;
      const marker = bytes[at++];
      if (marker === undefined || at + 2 > bytes.length) break;
      if (marker === 0xd9 || marker === 0xda) break;
      const size = bytes.readUInt16BE(at);
      if (size < 2 || at + size > bytes.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        size >= 8
      ) {
        dimensions = [bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 3)];
        break;
      }
      at += size;
    }
  }
  return dimensions?.[0] === image.width && dimensions[1] === image.height;
}
