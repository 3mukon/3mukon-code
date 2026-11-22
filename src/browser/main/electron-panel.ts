import {
  WebContentsView,
  type BrowserWindow,
  type Event,
  type Input,
  type MouseInputEvent,
} from 'electron';
import type { BrowserViewBounds } from '../shared/view';
import { FILE_DRAG_SCRIPT } from './file-drag';
import type { MountedBrowserPage } from './page';

const FILE_DRAG_TITLES = ['app-file-drag-1', 'app-file-drag-2'];

// The tab owns its WebContents. This mount owns its attachment and a sandboxed paper layer.
export class ElectronBrowserPanel implements MountedBrowserPage {
  private revision = 0;
  private visible = false;
  private dimmed = false;
  private clicked = false;
  private released = false;
  private dimmer?: { view: WebContentsView; paper: string; ready: Promise<boolean> };

  constructor(
    private readonly page: WebContentsView,
    private readonly window: BrowserWindow,
    private readonly userInput: () => boolean,
    private readonly focused: () => void,
    private readonly resized: () => void,
    private readonly fileDragged: () => void = () => undefined,
  ) {
    page.webContents.on('before-mouse-event', this.mouse);
    page.webContents.on('before-input-event', this.key);
  }

  async show(bounds: BrowserViewBounds, paper: string | null): Promise<boolean> {
    if (!this.usable()) return false;
    const revision = ++this.revision;
    const previous = this.page.getBounds();
    if (this.dimmed && paper === null) this.clicked = false;
    this.dimmed = paper !== null;
    let dim = paper === null ? undefined : this.paperLayer(paper);
    if (dim) {
      // Park the page while a new dimmer is loading so it cannot take the focusing click.
      if (!dim.view.getVisible()) {
        this.visible = false;
        this.page.setVisible(false);
      }
      const loaded = await dim.ready;
      if (revision !== this.revision || !this.usable()) return false;
      if (!loaded) {
        this.disposeDimmer();
        dim = undefined;
      }
    }

    const hostHadFocus = this.window.isFocused() && this.window.webContents.isFocused();
    const content = this.window.contentView;
    this.page.setBounds(bounds);
    if (!content.children.includes(this.page)) content.addChildView(this.page);
    if (dim) {
      dim.view.setBounds(bounds);
      if (!content.children.includes(dim.view)) content.addChildView(dim.view);
      dim.view.setVisible(true);
    } else this.hideDimmer();
    this.visible = true;
    this.page.setVisible(true);
    if (hostHadFocus && this.page.webContents.isFocused()) this.window.webContents.focus();
    if (previous.width !== bounds.width || previous.height !== bounds.height) this.resized();
    return this.visible;
  }

  hide(): void {
    this.revision++;
    this.visible = false;
    this.clicked = false;
    if (!this.page.webContents.isDestroyed()) this.page.setVisible(false);
    this.hideDimmer();
    if (!this.window.isDestroyed() && this.window.contentView.children.includes(this.page))
      this.window.contentView.removeChildView(this.page);
  }

  giveUpFileDrag(): void {
    if (!this.visible || !this.usable()) return;
    this.hide();
    this.fileDragged();
  }

  release(): void {
    if (this.released) return;
    this.hide();
    this.released = true;
    if (!this.page.webContents.isDestroyed()) {
      this.page.webContents.off('before-mouse-event', this.mouse);
      this.page.webContents.off('before-input-event', this.key);
    }
    this.disposeDimmer();
  }

  private usable(): boolean {
    return !this.released && !this.window.isDestroyed() && !this.page.webContents.isDestroyed();
  }

  private mouse = (event: Event, mouse: MouseInputEvent): void => {
    if (!this.visible || this.dimmed || !this.window.isFocused()) {
      event.preventDefault();
      this.focusDimmedPanel(mouse);
      return;
    }
    if (mouse.type === 'mouseDown') {
      this.clicked = this.userInput();
      if (this.clicked) this.focused();
      else event.preventDefault();
    }
    if (mouse.type === 'mouseWheel' && !this.userInput()) event.preventDefault();
  };

  private key = (event: Event, input: Input): void => {
    if (!this.visible || this.dimmed || !this.clicked || !this.window.isFocused()) {
      event.preventDefault();
    } else if (input.type === 'keyDown' && !this.userInput()) event.preventDefault();
  };

  private paperLayer(paper: string): NonNullable<ElectronBrowserPanel['dimmer']> {
    if (this.dimmer?.paper === paper) return this.dimmer;
    this.disposeDimmer();
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        disableDialogs: true,
        navigateOnDragDrop: false,
      },
    });
    view.setVisible(false);
    view.setBackgroundColor('#00000000');
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event) => {
      event.preventDefault();
    });
    contents.on('page-title-updated', (event, title) => {
      event.preventDefault();
      if (FILE_DRAG_TITLES.includes(title)) this.giveUpFileDrag();
    });
    contents.on('before-mouse-event', (event, mouse) => {
      event.preventDefault();
      this.focusDimmedPanel(mouse);
    });
    contents.on('before-input-event', (event) => {
      event.preventDefault();
    });
    const html =
      '<!doctype html><meta http-equiv="Content-Security-Policy" ' +
      "content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'\">" +
      '<style>html{background:' +
      paper +
      '4d}</style><script>' +
      FILE_DRAG_SCRIPT +
      '(() => { const [first, second] = ' +
      JSON.stringify(FILE_DRAG_TITLES) +
      '; document.title = document.title === first ? second : first; });</script>';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loaded = contents.loadURL('data:text/html,' + encodeURIComponent(html));
    const ready = Promise.race([
      loaded.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, 1000);
      }),
    ]).finally(() => {
      clearTimeout(timer);
    });
    this.dimmer = { view, paper, ready };
    return this.dimmer;
  }

  private focusDimmedPanel(mouse: MouseInputEvent): void {
    if (this.visible && this.dimmed && mouse.type === 'mouseDown' && this.window.isFocused()) {
      this.window.webContents.focus();
      this.focused();
    }
  }

  private hideDimmer(): void {
    const dim = this.dimmer?.view;
    if (!dim) return;
    dim.setVisible(false);
    if (!this.window.isDestroyed() && this.window.contentView.children.includes(dim))
      this.window.contentView.removeChildView(dim);
  }

  private disposeDimmer(): void {
    const dim = this.dimmer;
    if (!dim) return;
    this.hideDimmer();
    delete this.dimmer;
    if (!dim.view.webContents.isDestroyed()) dim.view.webContents.close();
  }
}
