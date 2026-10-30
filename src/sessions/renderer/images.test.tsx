import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initI18n } from '../../i18n/renderer/i18n';
import { Images } from './images';
import { TimelineActionsContext, type TimelineActions } from './timeline-actions';

beforeAll(() => {
  initI18n(['en-US']);
});
afterEach(cleanup);

const png = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
const jpeg = { mediaType: 'image/jpeg', data: '/9j/4AAQ' };

function shown() {
  const actions = { copyText: vi.fn(), imageMenu: vi.fn() } satisfies TimelineActions;
  render(
    <TimelineActionsContext value={actions}>
      <Images images={[png, jpeg]} />
    </TimelineActionsContext>,
  );
  return actions;
}

describe('Images', () => {
  it('names each image, and enlarges one on a double click, not a single one', () => {
    shown();
    const second = screen.getByRole('button', { name: 'Image 2' });
    fireEvent.click(second, { detail: 1 });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.doubleClick(second);
    const dialog = screen.getByRole('dialog', { name: 'Image 2' });
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/jpeg;base64,/9j/4AAQ',
    );
  });

  it('enlarges an image from the keyboard', () => {
    shown();
    // A click from Return or Space has no pointer.
    fireEvent.click(screen.getByRole('button', { name: 'Image 1' }), { detail: 0 });
    expect(screen.getByRole('dialog', { name: 'Image 1' })).toBeDefined();
  });

  it('offers an image’s menu on a right click, in the timeline and enlarged', () => {
    const actions = shown();
    const first = screen.getByRole('button', { name: 'Image 1' });
    expect(fireEvent.contextMenu(first)).toBe(false);
    fireEvent.doubleClick(first);
    const enlarged = screen.getByRole('dialog').querySelector('img');
    if (enlarged === null) throw new Error('The image is not enlarged.');
    fireEvent.contextMenu(enlarged);
    expect(actions.imageMenu.mock.calls).toEqual([[png], [png]]);
  });
});
