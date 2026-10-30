import { describe, expect, it } from 'vitest';
import { imageExtension, imageTypeOf, imageUrl } from './images';

const base64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

describe('images', () => {
  it('tells the sendable types from their first bytes', () => {
    expect(imageTypeOf(base64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toBe(
      'image/png',
    );
    expect(imageTypeOf(base64([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
    expect(imageTypeOf(btoa('GIF89a......'))).toBe('image/gif');
    expect(imageTypeOf(btoa('RIFF\x10\x00\x00\x00WEBPVP8 '))).toBe('image/webp');
    expect(imageTypeOf(btoa('RIFF\x10\x00\x00\x00WAVEfmt '))).toBeUndefined();
    expect(imageTypeOf('not base64!')).toBeUndefined();
  });

  it('gives an image as a data URL and a file extension', () => {
    expect(imageUrl({ mediaType: 'image/png', data: 'AAAA' })).toBe('data:image/png;base64,AAAA');
    expect(imageExtension('image/jpeg')).toBe('jpg');
    expect(imageExtension('image/x-unknown')).toBe('png');
  });
});
