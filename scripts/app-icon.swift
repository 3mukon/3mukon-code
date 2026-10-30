// Draws the app's icons from a square picture, at 1024 pixels, into a folder:
// - icon.png: the picture as a full square, which macOS cuts to its own icon shape, as it does an
//   icon that fills its square; an icon with a shape of its own it shows shrunk on a grey tile.
// - dock-icon.png: the picture in macOS's icon shape, a square of 824 pixels with continuous corners
//   in the middle of the canvas, over a faint shadow, for the Dock of an app that runs unpackaged,
//   which shows its icon as it is. A superellipse of exponent 5 stands for Apple's continuous corners.
// Usage: swift scripts/app-icon.swift <picture> <folder>
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
  FileHandle.standardError.write(Data("usage: swift app-icon.swift <picture> <folder>\n".utf8))
  exit(2)
}
let picturePath = URL(fileURLWithPath: arguments[1])
let folder = URL(fileURLWithPath: arguments[2], isDirectory: true)

guard
  let source = CGImageSourceCreateWithURL(picturePath as CFURL, nil),
  let picture = CGImageSourceCreateImageAtIndex(source, 0, nil)
else {
  FileHandle.standardError.write(Data("The picture could not be read.\n".utf8))
  exit(1)
}

let canvas = 1024

// A canvas, with transparency or without it.
func newCanvas(opaque: Bool) -> CGContext {
  let alpha = opaque ? CGImageAlphaInfo.noneSkipLast : CGImageAlphaInfo.premultipliedLast
  guard
    let space = CGColorSpace(name: CGColorSpace.sRGB),
    let context = CGContext(
      data: nil, width: canvas, height: canvas, bitsPerComponent: 8, bytesPerRow: 0, space: space,
      bitmapInfo: alpha.rawValue)
  else {
    exit(1)
  }
  context.interpolationQuality = .high
  return context
}

// Draws the picture scaled to fill the rectangle, centred.
func drawPicture(in rect: CGRect, on context: CGContext) {
  let scale = max(rect.width / CGFloat(picture.width), rect.height / CGFloat(picture.height))
  let size = CGSize(width: CGFloat(picture.width) * scale, height: CGFloat(picture.height) * scale)
  context.draw(
    picture,
    in: CGRect(
      x: rect.midX - size.width / 2, y: rect.midY - size.height / 2, width: size.width,
      height: size.height))
}

func iconShape(in rect: CGRect) -> CGPath {
  let path = CGMutablePath()
  let exponent: CGFloat = 5
  let steps = 2048
  for step in 0...steps {
    let angle = CGFloat(step) / CGFloat(steps) * 2 * .pi
    let (c, s) = (cos(angle), sin(angle))
    let point = CGPoint(
      x: rect.midX + rect.width / 2 * copysign(pow(abs(c), 2 / exponent), c),
      y: rect.midY + rect.height / 2 * copysign(pow(abs(s), 2 / exponent), s))
    if step == 0 { path.move(to: point) } else { path.addLine(to: point) }
  }
  path.closeSubpath()
  return path
}

func write(_ context: CGContext, to name: String) {
  let path = folder.appendingPathComponent(name)
  guard
    let image = context.makeImage(),
    let destination = CGImageDestinationCreateWithURL(
      path as CFURL, UTType.png.identifier as CFString, 1, nil)
  else {
    exit(1)
  }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else {
    FileHandle.standardError.write(Data("\(name) could not be written.\n".utf8))
    exit(1)
  }
}

// The full square, without transparency.
let square = newCanvas(opaque: true)
drawPicture(in: CGRect(x: 0, y: 0, width: canvas, height: canvas), on: square)
write(square, to: "icon.png")

// The shaped icon: the shape filled under the picture casts the shadow, then the picture is cut to it.
let shaped = newCanvas(opaque: false)
let shapeRect = CGRect(x: 100, y: 100, width: 824, height: 824)
let shape = iconShape(in: shapeRect)
shaped.saveGState()
shaped.setShadow(
  offset: CGSize(width: 0, height: -8), blur: 18,
  color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.28))
shaped.addPath(shape)
shaped.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
shaped.fillPath()
shaped.restoreGState()
shaped.saveGState()
shaped.addPath(shape)
shaped.clip()
drawPicture(in: shapeRect, on: shaped)
shaped.restoreGState()
write(shaped, to: "dock-icon.png")
