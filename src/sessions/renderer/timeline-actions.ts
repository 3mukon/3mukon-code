import { createContext } from 'react';
import type { MessageImage } from '../shared/events';
import type { SessionsBridge } from '../shared/sessions';
import { pngOf } from './image-input';

// What a session page's timeline and composer do through the bridge: put a message's text on the
// clipboard, and offer an image's menu, which copies the image, as a PNG, or saves it. Outside a page,
// as in a test that gives none, they do nothing.
export interface TimelineActions {
  copyText(text: string): void;
  imageMenu(image: MessageImage): void;
}

export const TimelineActionsContext = createContext<TimelineActions>({
  copyText: () => undefined,
  imageMenu: () => undefined,
});

export function timelineActions(bridge: SessionsBridge): TimelineActions {
  return {
    copyText: (text) => {
      bridge.copyText(text).catch(report);
    },
    imageMenu: (image) => {
      bridge
        .imageMenu()
        .then(async (action) => {
          if (action === 'copy') await bridge.copyImage(await pngOf(image));
          else if (action === 'save') await bridge.saveImage(image);
        })
        .catch(report);
    },
  };
}

function report(error: unknown): void {
  console.error('The timeline could not do that:', error);
}
