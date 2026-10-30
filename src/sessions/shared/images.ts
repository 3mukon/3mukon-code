import type { MessageImage } from './events';

// The images a message can carry to every provider: the types each takes, and how many images of what
// size, as Claude's API takes them, the strictest of the three.
export const SENDABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type SendableImageType = (typeof SENDABLE_IMAGE_TYPES)[number];
export const MAX_IMAGES = 10;
// An image's bytes in base64.
export const MAX_IMAGE_BASE64 = 5 * 1024 * 1024;
// An image's long edge in pixels; a larger one is scaled down before it is sent.
export const MAX_IMAGE_EDGE = 2000;

const extensions: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

// An image as a data URL, which the window shows.
export function imageUrl(image: MessageImage): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

// The file name extension for an image's type, such as png.
export function imageExtension(mediaType: string): string {
  return extensions[mediaType] ?? 'png';
}

// The type of an image in base64 from its first bytes, for an image that a provider gives without
// one; undefined for anything but the sendable types.
export function imageTypeOf(data: string): SendableImageType | undefined {
  let head: string;
  try {
    head = atob(data.slice(0, 24));
  } catch {
    return undefined;
  }
  if (head.startsWith('\x89PNG\r\n\x1a\n')) return 'image/png';
  if (head.startsWith('\xff\xd8\xff')) return 'image/jpeg';
  if (head.startsWith('GIF8')) return 'image/gif';
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}
