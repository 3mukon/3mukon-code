import CoreGraphics
import Foundation

// A window while it is on the screen, as the compositor has it: where, and the windows above it, from
// the one directly above to the one in front.
struct WindowOnScreen {
    let number: CGWindowID
    let frame: CGRect
    let above: [CGWindowID]

    init?(_ number: CGWindowID, of pid: pid_t) {
        // From the front to the window itself.
        guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenAboveWindow, .optionIncludingWindow], number) as? [[String: Any]],
              let row = rows.last, Self.number(row) == number,
              (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              row[kCGWindowIsOnscreen as String] as? Bool == true,
              let bounds = row[kCGWindowBounds as String] as? NSDictionary,
              let frame = CGRect(dictionaryRepresentation: bounds) else { return nil }
        self.number = number
        self.frame = frame
        above = rows.dropLast().reversed().compactMap(Self.number)
    }

    private static func number(_ row: [String: Any]) -> CGWindowID? {
        (row[kCGWindowNumber as String] as? NSNumber)?.uint32Value
    }
}
