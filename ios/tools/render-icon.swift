import AppKit

let size = 1024.0
let ctx = CGContext(data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!

// Background gradient (deep navy -> blue)
let colors = [NSColor(red: 0.07, green: 0.13, blue: 0.30, alpha: 1).cgColor,
              NSColor(red: 0.16, green: 0.42, blue: 0.92, alpha: 1).cgColor] as CFArray
let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!
ctx.drawLinearGradient(gradient, start: CGPoint(x: 0, y: size), end: CGPoint(x: size, y: 0), options: [])

// Soft glow top-right
let glow = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                      colors: [NSColor(white: 1, alpha: 0.18).cgColor, NSColor(white: 1, alpha: 0).cgColor] as CFArray,
                      locations: [0, 1])!
ctx.drawRadialGradient(glow, startCenter: CGPoint(x: 780, y: 780), startRadius: 0, endCenter: CGPoint(x: 780, y: 780), endRadius: 620, options: [])

// Server rack: three bays
let bayW = 560.0, bayH = 128.0, gap = 36.0
let x = (size - bayW) / 2
let totalH = bayH * 3 + gap * 2
var y = (size - totalH) / 2
let dotColors = [NSColor(red: 0.30, green: 0.87, blue: 0.50, alpha: 1), NSColor(red: 0.30, green: 0.87, blue: 0.50, alpha: 1), NSColor(red: 1.0, green: 0.72, blue: 0.25, alpha: 1)]
for i in 0..<3 {
    let rect = CGRect(x: x, y: y, width: bayW, height: bayH)
    // shadow
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 30, color: NSColor(white: 0, alpha: 0.35).cgColor)
    ctx.setFillColor(NSColor(white: 1, alpha: 0.96).cgColor)
    ctx.addPath(CGPath(roundedRect: rect, cornerWidth: 32, cornerHeight: 32, transform: nil))
    ctx.fillPath()
    ctx.restoreGState()
    // vent lines on the left
    ctx.setFillColor(NSColor(red: 0.16, green: 0.42, blue: 0.92, alpha: 0.25).cgColor)
    for k in 0..<4 {
        let lx = x + 56 + Double(k) * 44
        ctx.addPath(CGPath(roundedRect: CGRect(x: lx, y: y + 36, width: 18, height: bayH - 72), cornerWidth: 9, cornerHeight: 9, transform: nil))
        ctx.fillPath()
    }
    // status dot on the right
    let d = 44.0
    ctx.setFillColor(dotColors[2 - i].cgColor)
    ctx.fillEllipse(in: CGRect(x: x + bayW - 56 - d, y: y + (bayH - d) / 2, width: d, height: d))
    y += bayH + gap
}

let cg = ctx.makeImage()!
let rep = NSBitmapImageRep(cgImage: cg)
let png = rep.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
print("wrote", CommandLine.arguments[1])
