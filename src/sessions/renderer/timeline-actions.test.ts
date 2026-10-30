import { describe, expect, it, vi } from 'vitest';
import type { SessionsBridge } from '../shared/sessions';
import { timelineActions } from './timeline-actions';

// Images become PNGs without a canvas, which the test's process lacks.
vi.mock('./image-input', () => ({
  pngOf: (image: { data: string }) => Promise.resolve({ mediaType: 'image/png', data: image.data }),
}));

function fakeBridge(action: 'copy' | 'save' | null) {
  return {
    copyText: vi.fn<SessionsBridge['copyText']>(() => Promise.resolve()),
    copyImage: vi.fn<SessionsBridge['copyImage']>(() => Promise.resolve()),
    saveImage: vi.fn<SessionsBridge['saveImage']>(() => Promise.resolve(true)),
    imageMenu: vi.fn<SessionsBridge['imageMenu']>(() => Promise.resolve(action)),
  };
}

const jpeg = { mediaType: 'image/jpeg', data: '/9j/4AAQ' };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('timelineActions', () => {
  it('copies a message’s text', () => {
    const bridge = fakeBridge(null);
    timelineActions(bridge as unknown as SessionsBridge).copyText('Hi');
    expect(bridge.copyText).toHaveBeenCalledExactlyOnceWith('Hi');
  });

  it('copies an image as a PNG, or saves it as it is, as the user chooses from its menu', async () => {
    for (const action of ['copy', 'save', null] as const) {
      const bridge = fakeBridge(action);
      timelineActions(bridge as unknown as SessionsBridge).imageMenu(jpeg);
      await settle();
      expect(bridge.copyImage.mock.calls).toEqual(
        action === 'copy' ? [[{ mediaType: 'image/png', data: jpeg.data }]] : [],
      );
      expect(bridge.saveImage.mock.calls).toEqual(action === 'save' ? [[jpeg]] : []);
    }
  });
});
