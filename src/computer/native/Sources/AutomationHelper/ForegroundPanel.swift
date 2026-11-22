import AppKit

private final class NonActivatingPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// The renderer supplies the frame. Native buttons give its two interaction areas AppKit
// mouse handling and accessible names without redrawing the renderer's content.
private final class FrameButton: NSButton {
    override var acceptsFirstResponder: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func draw(_ dirtyRect: NSRect) {}
}

@MainActor
final class ForegroundPanel: NSObject {
    private var window: NonActivatingPanel?
    private var current: (revision: Int, bounds: NativeBounds)?
    private var onCommand: ((Int, String) -> Void)?

    func show(_ frame: NativeControlFrame?, revision: Int, command: @escaping (Int, String) -> Void) {
        current = nil
        onCommand = nil
        guard let frame else {
            window?.orderOut(nil)
            return
        }
        let rect = frame.bounds.rect
        guard rect.width > 0, rect.width <= 560, rect.height > 0, rect.height <= 48,
              let screen = NSScreen.screens.first, (1...2).contains(frame.buttons.count),
              frame.image.count <= 384 * 1024,
              let bitmap = NSBitmapImageRep(data: frame.image),
              bitmap.pixelsWide <= Int(rect.width) * 3, bitmap.pixelsHigh <= Int(rect.height) * 3
        else {
            window?.orderOut(nil)
            return
        }

        let placement = NSRect(x: rect.minX, y: screen.frame.maxY - rect.maxY,
                               width: rect.width, height: rect.height)
        let contentRect = CGRect(origin: .zero, size: placement.size)
        let view = NSView(frame: contentRect)
        let image = NSImage(size: contentRect.size)
        image.addRepresentation(bitmap)
        let imageView = NSImageView(frame: contentRect)
        imageView.image = image
        imageView.imageScaling = .scaleAxesIndependently
        imageView.setAccessibilityElement(false)
        view.addSubview(imageView)
        for item in frame.buttons {
            let hit = item.bounds.rect
            guard contentRect.contains(hit), !hit.isEmpty, item.label.count <= 80,
                  ["stop", "hand-back"].contains(item.command) else { continue }
            let button = FrameButton(frame: CGRect(x: hit.minX, y: rect.height - hit.maxY,
                                                   width: hit.width, height: hit.height))
            button.title = item.label
            button.setAccessibilityLabel(item.label)
            button.isEnabled = item.enabled
            button.identifier = NSUserInterfaceItemIdentifier(item.command)
            button.target = self
            button.action = #selector(clicked(_:))
            view.addSubview(button)
        }

        let panel = window ?? makePanel(placement)
        panel.contentView = view
        panel.setFrame(placement, display: true)
        if !panel.isVisible { panel.orderFrontRegardless() }
        current = (revision, frame.bounds)
        onCommand = command
    }

    func surface(revision: Int) -> NativeControlSurface? {
        guard let current, current.revision == revision, let window, window.isVisible,
              let id = CGWindowID(exactly: window.windowNumber), id != 0 else { return nil }
        return NativeControlSurface(windowId: id, bounds: current.bounds)
    }

    @objc private func clicked(_ button: NSButton) {
        guard let current, let command = button.identifier?.rawValue, button.window === window else { return }
        onCommand?(current.revision, command)
    }

    private func makePanel(_ frame: NSRect) -> NonActivatingPanel {
        let panel = NonActivatingPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                                       backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        if #available(macOS 13.0, *) { panel.collectionBehavior.insert(.canJoinAllApplications) }
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        window = panel
        return panel
    }
}
