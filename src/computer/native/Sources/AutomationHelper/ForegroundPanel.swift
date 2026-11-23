import AppKit

private final class NonActivatingPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    // It goes where its window goes, past the edges of the display too.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

// The renderer supplies the pictures: the control's, and what each button looks like under the pointer
// and pressed. Native buttons give their areas AppKit mouse handling and accessible names without
// redrawing the renderer's content.
private final class FrameButton: NSButton {
    var hover: NSImage?
    var pressed: NSImage?
    var isHovered = false
    private var drawn: NSImage?

    override var acceptsFirstResponder: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        drawn = picture
        drawn?.draw(in: bounds)
    }

    func refresh() {
        if drawn !== picture { needsDisplay = true }
    }

    private var picture: NSImage? {
        isHighlighted ? pressed : isHovered ? hover : nil
    }
}

@MainActor
final class ForegroundPanel: NSObject {
    private struct Shown {
        let target: UUID
        let size: CGSize
        // Where the control is, while its window is on the screen.
        var bounds: NativeBounds?
    }

    private let catalog: NativeWindowCatalog
    private let pointer: () -> NSPoint
    private lazy var shortcut = StopShortcut { [weak self] in self?.send("shortcut") }
    private var panel: NonActivatingPanel?
    private var revision = 0
    private var current: Shown?
    // The windows between the control's window and the control, as macOS last put that above it.
    private var attached: [CGWindowID]?
    private var fullScreen: (window: UUID, frame: CGRect, answer: Bool, read: ContinuousClock.Instant)?
    private var following: Timer?
    private var steps = 0
    private var moved = ContinuousClock.now
    private var onCommand: ((Int, String) -> Void)?

    init(catalog: NativeWindowCatalog, pointer: @escaping () -> NSPoint = { NSEvent.mouseLocation }) {
        self.catalog = catalog
        self.pointer = pointer
    }

    func show(_ frame: NativeControlFrame?, revision: Int, command: @escaping (Int, String) -> Void) {
        self.revision = revision
        // The shortcut is there while something is in control, wherever its window is.
        if frame == nil {
            onCommand = nil
            shortcut.stopListening()
        } else {
            onCommand = command
            shortcut.listen()
        }
        guard let frame, let view = contents(frame) else {
            hide()
            return
        }
        let panel = self.panel ?? makePanel(view.frame)
        panel.contentView = view
        panel.setContentSize(view.frame.size)
        current = Shown(target: frame.window, size: view.frame.size)
        place()
        follow()
    }

    private func hide() {
        current = nil
        fullScreen = nil
        following?.invalidate()
        following = nil
        panel?.orderOut(nil)
    }

    private func contents(_ frame: NativeControlFrame) -> NSView? {
        let size = CGSize(width: frame.size.width, height: frame.size.height)
        guard size.width > 0, size.width <= 560, size.height > 0, size.height <= 48,
              (1...2).contains(frame.buttons.count),
              frame.image.count <= 384 * 1024, let image = Self.picture(frame.image, size: size) else { return nil }
        let contentRect = CGRect(origin: .zero, size: size)
        let view = NSView(frame: contentRect)
        let imageView = NSImageView(frame: contentRect)
        imageView.image = image
        imageView.imageScaling = .scaleAxesIndependently
        imageView.setAccessibilityElement(false)
        view.addSubview(imageView)
        for item in frame.buttons {
            let hit = item.bounds.rect
            guard contentRect.contains(hit), !hit.isEmpty, item.label.count <= 80,
                  ["stop", "hand-back"].contains(item.command) else { continue }
            let button = FrameButton(frame: CGRect(x: hit.minX, y: size.height - hit.maxY,
                                                   width: hit.width, height: hit.height))
            button.title = item.label
            button.setAccessibilityLabel(item.label)
            button.isEnabled = item.enabled
            button.hover = item.hover.flatMap { Self.picture($0, size: hit.size) }
            button.pressed = item.pressed.flatMap { Self.picture($0, size: hit.size) }
            button.identifier = NSUserInterfaceItemIdentifier(item.command)
            button.target = self
            button.action = #selector(clicked(_:))
            view.addSubview(button)
        }
        return view
    }

    private static func picture(_ data: Data, size: CGSize) -> NSImage? {
        guard let bitmap = NSBitmapImageRep(data: data),
              bitmap.pixelsWide <= Int((size.width * 3).rounded(.up)),
              bitmap.pixelsHigh <= Int((size.height * 3).rounded(.up)) else { return nil }
        let image = NSImage(size: size)
        image.addRepresentation(bitmap)
        return image
    }

    private func follow() {
        guard following == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 120, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.step() }
        }
        RunLoop.main.add(timer, forMode: .common)
        following = timer
    }

    // Half as often while the window stays where it is.
    private func step() {
        steps += 1
        if steps.isMultiple(of: 2) || moved.duration(to: .now) < .milliseconds(300) { place() }
    }

    // The control goes with its window, whoever moves that: above it, next to it among the windows on
    // the screen, and off the screen while it is.
    private func place() {
        guard let shown = current, let panel else { return }
        guard let target = catalog.onScreen(shown.target), let bounds = bounds(shown.size, target, of: shown.target) else {
            current?.bounds = nil
            // One on another Space is there with its window.
            if panel.isVisible, panel.isOnActiveSpace { panel.orderOut(nil) }
            return
        }
        let origin = Self.flipped(bounds.rect).origin
        if panel.frame.origin != origin {
            panel.setFrameOrigin(origin)
            moved = .now
        }
        if panel.isVisible, !panel.isOnActiveSpace { panel.orderOut(nil) }
        order(panel, target)
        current?.bounds = bounds
        react()
    }

    // macOS keeps the windows that are attached to one together with it, as its title bar in full
    // screen, and puts the control above them too. Any other one that comes between covers both.
    private func order(_ panel: NSPanel, _ target: WindowOnScreen) {
        let own = target.above.firstIndex { Int($0) == panel.windowNumber }
        if panel.isVisible, let between = own.map({ Array(target.above[..<$0]) }), between == attached ?? between {
            attached = between
        } else {
            panel.order(.above, relativeTo: Int(target.number))
            attached = nil
        }
    }

    // The pointer can come to lie on a button as the control moves, so this reads where it is.
    private func react() {
        guard let panel, let buttons = panel.contentView?.subviews.compactMap({ $0 as? FrameButton }) else { return }
        let pointer = pointer()
        let over = panel.frame.contains(pointer) &&
            NSWindow.windowNumber(at: pointer, belowWindowWithWindowNumber: 0) == panel.windowNumber
        for button in buttons {
            button.isHovered = over && button.isEnabled && button.frame.contains(panel.convertPoint(fromScreen: pointer))
            button.refresh()
        }
    }

    private func bounds(_ size: CGSize, _ target: WindowOnScreen, of id: UUID) -> NativeBounds? {
        // The display that holds the most of the window.
        let shared = { (screen: NSScreen) -> CGFloat in
            let part = Self.flipped(screen.frame).intersection(target.frame)
            return part.isNull ? 0 : part.width * part.height
        }
        if let screen = NSScreen.screens.max(by: { shared($0) < shared($1) }), isFullScreen(id, target.frame, on: screen) {
            let top = Self.flipped(screen.frame).minY + screen.safeAreaInsets.top
            return NativeBounds(ControlPlacement.inFullScreen(target.frame, displayTop: top, size: size))
        }
        return NativeBounds(ControlPlacement.above(target.frame, size: size))
    }

    // Only a window about as high as its display can be in full screen. Its application says whether
    // it is, again where its frame changes and twice a second.
    private func isFullScreen(_ id: UUID, _ frame: CGRect, on screen: NSScreen) -> Bool {
        guard frame.height > screen.frame.height * 0.9 else { return false }
        let now = ContinuousClock.now
        if let known = fullScreen, known.window == id, known.frame == frame,
           known.read.duration(to: now) < .milliseconds(500) { return known.answer }
        let answer = catalog.isFullScreen(id)
        fullScreen = (id, frame, answer, now)
        return answer
    }

    // AppKit counts points from the bottom of the primary display, and everything else here from its top.
    private static func flipped(_ rect: CGRect) -> CGRect {
        let height = NSScreen.screens.first?.frame.maxY ?? 0
        return CGRect(x: rect.minX, y: height - rect.maxY, width: rect.width, height: rect.height)
    }

    func surface(revision: Int) -> NativeControlSurface? {
        guard self.revision == revision, let bounds = current?.bounds, let panel, panel.isVisible,
              let id = CGWindowID(exactly: panel.windowNumber), id != 0 else { return nil }
        return NativeControlSurface(windowId: id, bounds: bounds)
    }

    @objc private func clicked(_ button: NSButton) {
        guard let command = button.identifier?.rawValue, button.window === panel else { return }
        send(command)
    }

    private func send(_ command: String) {
        onCommand?(revision, command)
    }

    private func makePanel(_ frame: NSRect) -> NonActivatingPanel {
        let panel = NonActivatingPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                                       backing: .buffered, defer: false)
        panel.level = .normal
        panel.hidesOnDeactivate = false
        panel.animationBehavior = .none
        panel.isMovable = false
        panel.collectionBehavior = [.transient, .fullScreenAuxiliary, .ignoresCycle]
        if #available(macOS 13.0, *) { panel.collectionBehavior.insert(.canJoinAllApplications) }
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        self.panel = panel
        return panel
    }
}
