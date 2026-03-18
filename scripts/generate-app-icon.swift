#!/usr/bin/env swift
// scripts/generate-app-icon.swift
// Generates AppIcon PNGs for the macOS asset catalog.
// Usage: swift scripts/generate-app-icon.swift

import Cocoa

// Claude brand orange (#D97757) — keep in sync with BrandColors.swift
let brandOrange = NSColor(srgbRed: 0.851, green: 0.467, blue: 0.341, alpha: 1)

/// Renders the icon at exact pixel dimensions using NSBitmapImageRep
/// (bypasses Retina backing-scale that lockFocus would apply).
func renderIconPNG(pixels: Int) -> Data? {
    let px = pixels
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: px, pixelsHigh: px,
        bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false,
        colorSpaceName: .calibratedRGB,
        bytesPerRow: 0, bitsPerPixel: 0
    ) else { return nil }
    rep.size = NSSize(width: px, height: px) // 1:1 point-to-pixel

    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

    let s = CGFloat(px)
    let u = s / 100.0

    // Background
    brandOrange.setFill()
    NSBezierPath(rect: NSRect(x: 0, y: 0, width: s, height: s)).fill()

    // Robot — white silhouette
    NSColor.white.setFill()
    NSBezierPath(roundedRect: NSRect(x: u*22, y: u*38, width: u*56, height: u*30), xRadius: u*8, yRadius: u*8).fill()
    NSBezierPath(roundedRect: NSRect(x: u*46, y: u*68, width: u*8, height: u*10), xRadius: u*3, yRadius: u*3).fill()
    NSBezierPath(ovalIn: NSRect(x: u*43, y: u*76, width: u*14, height: u*14)).fill()
    NSBezierPath(roundedRect: NSRect(x: u*26, y: u*10, width: u*48, height: u*24), xRadius: u*6, yRadius: u*6).fill()
    NSBezierPath(roundedRect: NSRect(x: u*14, y: u*14, width: u*8, height: u*16), xRadius: u*3, yRadius: u*3).fill()
    NSBezierPath(roundedRect: NSRect(x: u*78, y: u*14, width: u*8, height: u*16), xRadius: u*3, yRadius: u*3).fill()

    // Eyes
    brandOrange.setFill()
    NSBezierPath(roundedRect: NSRect(x: u*31, y: u*47, width: u*12, height: u*12), xRadius: u*3, yRadius: u*3).fill()
    NSBezierPath(roundedRect: NSRect(x: u*57, y: u*47, width: u*12, height: u*12), xRadius: u*3, yRadius: u*3).fill()

    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}

// macOS app icon sizes: point size × scale factor → pixel size
let sizes: [(points: Int, scale: Int)] = [
    (16, 1), (16, 2),
    (32, 1), (32, 2),
    (128, 1), (128, 2),
    (256, 1), (256, 2),
    (512, 1), (512, 2),
]

// Output directory
let baseDir = "ClaudeInSafari/Assets.xcassets/AppIcon.appiconset"
let fm = FileManager.default
try? fm.createDirectory(atPath: baseDir, withIntermediateDirectories: true)

print("Generating app icons...")
var contentsImages: [[String: Any]] = []

for (points, scale) in sizes {
    let pixels = points * scale
    let filename = "icon_\(points)x\(points)\(scale > 1 ? "@\(scale)x" : "").png"
    guard let png = renderIconPNG(pixels: pixels) else {
        print("ERROR: failed to render \(filename)")
        continue
    }
    try png.write(to: URL(fileURLWithPath: "\(baseDir)/\(filename)"))
    print("  ✓ \(baseDir)/\(filename) (\(pixels)×\(pixels)px)")
    contentsImages.append([
        "filename": filename,
        "idiom": "mac",
        "scale": "\(scale)x",
        "size": "\(points)x\(points)",
    ])
}

// Write Contents.json
let contents: [String: Any] = [
    "images": contentsImages,
    "info": ["author": "xcode", "version": 1],
]
let json = try JSONSerialization.data(withJSONObject: contents, options: [.prettyPrinted, .sortedKeys])
try json.write(to: URL(fileURLWithPath: "\(baseDir)/Contents.json"))
print("  ✓ \(baseDir)/Contents.json")

// Also create the top-level Assets.xcassets/Contents.json if missing
let assetsContents = "ClaudeInSafari/Assets.xcassets/Contents.json"
if !fm.fileExists(atPath: assetsContents) {
    let top = try JSONSerialization.data(withJSONObject: ["info": ["author": "xcode", "version": 1]], options: [.prettyPrinted, .sortedKeys])
    try top.write(to: URL(fileURLWithPath: assetsContents))
    print("  ✓ \(assetsContents)")
}

print("Done! \(sizes.count) icons generated.")
