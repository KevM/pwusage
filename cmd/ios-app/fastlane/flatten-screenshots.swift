// Redraws each PNG onto an opaque white background and saves it in place
// without an alpha channel, which App Store Connect requires. The iPad
// captures come out with alpha, and the open Duo's inner capture comes out
// one pixel under 2853x2007, so it is scaled to the accepted size. Exact
// opaque files pass through unchanged.
// Usage: swift flatten-screenshots.swift <png>...

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// App Store Connect wants exactly 2853x2007 (or 2007x2853) for the open
/// Duo, but XCUIScreen rounds the fractional point size down by one pixel.
func appStoreSize(for image: CGImage) -> (width: Int, height: Int)? {
    // Either axis can truncate independently, so accept both one-pixel cases.
    switch (image.width, image.height) {
    case (2852 ... 2853, 2006 ... 2007) where image.width != 2853 || image.height != 2007:
        return (2853, 2007)
    case (2006 ... 2007, 2852 ... 2853) where image.width != 2007 || image.height != 2853:
        return (2007, 2853)
    default:
        return nil
    }
}

func flatten(_ url: URL) throws -> Bool {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { throw CocoaError(.fileReadCorruptFile, userInfo: [NSFilePathErrorKey: url.path]) }

    let hasAlpha: Bool
    switch image.alphaInfo {
    case .none, .noneSkipFirst, .noneSkipLast: hasAlpha = false
    default: hasAlpha = true
    }
    let target = appStoreSize(for: image)
    guard hasAlpha || target != nil else { return false }

    let width = target?.width ?? image.width
    let height = target?.height ?? image.height
    guard let space = image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
              data: nil, width: width, height: height,
              bitsPerComponent: 8, bytesPerRow: 0, space: space,
              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
          ) else { throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path]) }
    let rect = CGRect(x: 0, y: 0, width: width, height: height)
    context.setFillColor(CGColor(gray: 1, alpha: 1))
    context.fill(rect)
    context.draw(image, in: rect)

    guard let opaque = context.makeImage(),
          let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path]) }
    CGImageDestinationAddImage(destination, opaque, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
    }
    return true
}

var failed = false
for path in CommandLine.arguments.dropFirst() {
    do {
        if try flatten(URL(fileURLWithPath: path)) { print("Flattened \(path)") }
    } catch {
        FileHandle.standardError.write(Data("\(path): \(error)\n".utf8))
        failed = true
    }
}
exit(failed ? 1 : 0)
