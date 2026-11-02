// Redraws each PNG onto an opaque white background and saves it in place
// without an alpha channel, which App Store Connect requires. The iPad
// captures come out with alpha; opaque files pass through unchanged.
// Usage: swift flatten-screenshots.swift <png>...

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

func flatten(_ url: URL) throws -> Bool {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { throw CocoaError(.fileReadCorruptFile, userInfo: [NSFilePathErrorKey: url.path]) }

    switch image.alphaInfo {
    case .none, .noneSkipFirst, .noneSkipLast: return false
    default: break
    }

    guard let space = image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(
              data: nil, width: image.width, height: image.height,
              bitsPerComponent: 8, bytesPerRow: 0, space: space,
              bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
          ) else { throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path]) }
    let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
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
