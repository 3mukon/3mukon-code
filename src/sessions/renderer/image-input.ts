import type { MessageImage } from '../shared/events';
import {
  MAX_IMAGE_BASE64,
  MAX_IMAGE_EDGE,
  SENDABLE_IMAGE_TYPES,
  type SendableImageType,
} from '../shared/images';

// Why an image cannot go with a message: a type no provider takes everywhere, a size too large even
// scaled down, or bytes that are no image.
export type ImageRefusal = 'type' | 'size' | 'unreadable';

// An image the user pasted or dropped, ready to go with a message: of a type every provider takes, at
// most MAX_IMAGE_EDGE pixels on its long edge and MAX_IMAGE_BASE64 in base64. A larger image is
// scaled down, a GIF then becoming a PNG, and one still too large becomes a JPEG; an image within the
// limits goes as it is.
export async function readImage(file: Blob): Promise<MessageImage | { refused: ImageRefusal }> {
  const type = sendable(file.type);
  if (type === undefined) return { refused: 'type' };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { refused: 'unreadable' };
  }
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) {
      const data = await base64Of(file);
      if (data.length <= MAX_IMAGE_BASE64) return { mediaType: type, data };
    }
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    for (const encoding of type === 'image/jpeg' ? ['image/jpeg' as const] : redrawn(type)) {
      const data = await base64Of(await draw(bitmap, width, height, encoding));
      if (data.length <= MAX_IMAGE_BASE64) return { mediaType: encoding, data };
    }
    return { refused: 'size' };
  } finally {
    bitmap.close();
  }
}

// An image as a PNG, the type the clipboard takes from every app.
export async function pngOf(image: MessageImage): Promise<MessageImage> {
  if (image.mediaType === 'image/png') return image;
  const bytes = Uint8Array.from(atob(image.data), (character) => character.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: image.mediaType }));
  try {
    const png = await draw(bitmap, bitmap.width, bitmap.height, 'image/png');
    return { mediaType: 'image/png', data: await base64Of(png) };
  } finally {
    bitmap.close();
  }
}

function sendable(type: string): SendableImageType | undefined {
  return SENDABLE_IMAGE_TYPES.find((candidate) => candidate === type);
}

// The types a redrawn image tries in turn: its own, a GIF's being PNG, then JPEG.
function redrawn(type: SendableImageType): SendableImageType[] {
  return [type === 'image/gif' ? 'image/png' : type, 'image/jpeg'];
}

// The image drawn at the size, as the type; a JPEG, which has no transparency, on white.
async function draw(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  type: SendableImageType,
): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('The image could not be drawn.');
  if (type === 'image/jpeg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(bitmap, 0, 0, width, height);
  return canvas.convertToBlob({ type, quality: 0.9 });
}

async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}
