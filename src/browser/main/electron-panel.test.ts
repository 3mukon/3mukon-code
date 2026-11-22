import { WebContentsView, type BrowserWindow } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';
import { ElectronBrowserPanel } from './electron-panel';

const load = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Contents extends EventEmitter {
    loadURL = load;
    setWindowOpenHandler = vi.fn();
    close = vi.fn();
    isDestroyed = () => false;
    isFocused = () => false;
  }
  return {
    WebContentsView: class {
      webContents = new Contents();
      private bounds = { x: 0, y: 0, width: 0, height: 0 };
      private visible = false;
      setBackgroundColor = vi.fn();
      setBounds(bounds: typeof this.bounds) {
        this.bounds = bounds;
      }
      getBounds() {
        return this.bounds;
      }
      setVisible(value: boolean) {
        this.visible = value;
      }
      getVisible() {
        return this.visible;
      }
    },
  };
});

const bounds = { x: 15, y: 20, width: 320, height: 200 };
beforeEach(() => {
  load.mockReset().mockResolvedValue(undefined);
});

it.each([true, false])(
  'consumes a dimmed focusing click with or without a paper layer (%s)',
  async (layer) => {
    if (!layer) load.mockRejectedValueOnce(Error('Fixture paper layer unavailable'));
    const page = new WebContentsView();
    const children: WebContentsView[] = [];
    const focus = vi.fn();
    const window = {
      webContents: { isFocused: () => true, focus },
      isFocused: () => true,
      isDestroyed: () => false,
      contentView: {
        children,
        addChildView(view: WebContentsView) {
          children.push(view);
        },
        removeChildView(view: WebContentsView) {
          children.splice(children.indexOf(view), 1);
        },
      },
    } as unknown as BrowserWindow;
    const takeover = vi.fn(() => true);
    const focused = vi.fn();
    const resized = vi.fn();
    const panel = new ElectronBrowserPanel(page, window, takeover, focused, resized);

    expect(await panel.show(bounds, '#efece4')).toBe(true);
    expect(children).toHaveLength(layer ? 2 : 1);
    expect(focus).not.toHaveBeenCalled();
    expect(focused).not.toHaveBeenCalled();
    const layerOrPage = children.at(-1);
    const press = { type: 'mouseDown' };
    const focusing = { preventDefault: vi.fn() };
    layerOrPage?.webContents.emit('before-mouse-event', focusing, press);
    expect(focusing.preventDefault).toHaveBeenCalledOnce();
    expect(focused).toHaveBeenCalledOnce();
    expect(takeover).not.toHaveBeenCalled();

    expect(await panel.show(bounds, null)).toBe(true);
    const keyBeforeClick = { preventDefault: vi.fn() };
    page.webContents.emit('before-input-event', keyBeforeClick, { type: 'keyDown' });
    expect(keyBeforeClick.preventDefault).toHaveBeenCalledOnce();
    const click = { preventDefault: vi.fn() };
    page.webContents.emit('before-mouse-event', click, press);
    expect(click.preventDefault).not.toHaveBeenCalled();
    expect(takeover).toHaveBeenCalledOnce();
    expect(focused).toHaveBeenCalledTimes(2);
    expect(resized).toHaveBeenCalledOnce();

    const close = vi.spyOn(page.webContents, 'close');
    panel.release();
    expect(children).toEqual([]);
    expect(close).not.toHaveBeenCalled();
  },
);
