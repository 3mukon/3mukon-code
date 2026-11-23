import CoreGraphics

// Where the foreground control lies, in points from the top left: just above the window it is about,
// in the middle of it, wherever that window is, past the edges of the display too. Above a window in
// full screen there is nothing, so there it lies at the top of the display. In whole points, as the
// panel is found again by its frame.
enum ControlPlacement {
    // Below the control, whose edges its picture leaves free, and above it at the top of a display.
    private static let gap = 3.0
    private static let top = 14.0

    static func above(_ window: CGRect, size: CGSize) -> CGRect {
        place(size, in: window, at: window.minY.rounded(.down) - gap - size.height)
    }

    static func inFullScreen(_ window: CGRect, displayTop: CGFloat, size: CGSize) -> CGRect {
        place(size, in: window, at: max(window.minY, displayTop).rounded(.up) + top)
    }

    private static func place(_ size: CGSize, in window: CGRect, at y: CGFloat) -> CGRect {
        CGRect(x: (window.midX - size.width / 2).rounded(), y: y, width: size.width, height: size.height)
    }
}
