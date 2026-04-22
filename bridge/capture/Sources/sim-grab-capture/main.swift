// sim-grab-capture
// -------------------
// Captures the iOS Simulator.app window via ScreenCaptureKit and streams
// JPEG frames out on stdout. This is the same underlying mechanism
// Simulator.app itself and Xcode SwiftUI previews use (WindowServer XPC
// delivers CVPixelBuffers on a persistent stream). It's ~10x faster
// than spawning `xcrun simctl io screenshot` per frame and sidesteps
// every idb video-stream / WebCodecs pain point.
//
// Wire format on stdout (little surprise, one frame at a time):
//
//   ┌──────────────┬──────────────────────┬───────────────┐
//   │  4 bytes BE  │        payload       │    repeat …   │
//   │  u32 length  │  JPEG bytes (length) │               │
//   └──────────────┴──────────────────────┴───────────────┘
//
// First "frame" is actually a JSON meta blob (same framing, starts with
// an ASCII `{`) describing the pixel dimensions and fps. The bridge
// uses the leading byte to tell them apart.
//
// stderr is used for human-readable status ("capture:ready", error
// messages, etc). Parent process reads only stdout for frames.

import Foundation
import ScreenCaptureKit
import CoreImage
import CoreVideo
import CoreMedia
import AppKit
import os

// --- config via env ---------------------------------------------------------

let FPS: Int = Int(ProcessInfo.processInfo.environment["CAPTURE_FPS"] ?? "") ?? 50
let QUALITY: Double = Double(ProcessInfo.processInfo.environment["CAPTURE_QUALITY"] ?? "") ?? 0.7
let MAX_WIDTH: Int = Int(ProcessInfo.processInfo.environment["CAPTURE_MAX_WIDTH"] ?? "") ?? 1200

let SIM_BUNDLE_IDS: Set<String> = [
    "com.apple.iphonesimulator",
    "com.apple.CoreSimulator.SimulatorTrampoline",
]

// --- framed stdout writer ---------------------------------------------------
// SCStream callbacks come in on a background queue. Writes to stdout have to
// be serialized or frames get interleaved and the parent chokes.

final class FramedWriter {
    private let lock = NSLock()
    private let handle = FileHandle.standardOutput

    func write(_ payload: Data) {
        lock.lock()
        defer { lock.unlock() }
        var len = UInt32(payload.count).bigEndian
        var header = Data(bytes: &len, count: 4)
        header.append(payload)
        do {
            try handle.write(contentsOf: header)
        } catch {
            FileHandle.standardError.write("[capture] stdout write failed: \(error)\n".data(using: .utf8)!)
            exit(0)
        }
    }

    func writeJSON(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        write(data)
    }
}

let writer = FramedWriter()

func logErr(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}

// --- SCStream plumbing ------------------------------------------------------

final class Capture: NSObject, SCStreamDelegate, SCStreamOutput, @unchecked Sendable {
    private var stream: SCStream?
    private var window: SCWindow?
    private let ciContext: CIContext
    private let colorSpace: CGColorSpace

    private var frameCount = 0
    private var lastLog = Date()
    private var lastSentDims: (Int, Int)?

    override init() {
        // Hardware-accelerated CIContext; we use it both for the Metal-backed
        // JPEG encoder and (optionally) for downscaling before encode.
        self.ciContext = CIContext(options: [.useSoftwareRenderer: false])
        self.colorSpace = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        super.init()
    }

    // Find the simulator window, retrying a few times so we don't race the user
    // booting a sim right after the bridge starts.
    func findWindow() async throws -> SCWindow {
        for attempt in 1...12 {
            let content: SCShareableContent
            do {
                content = try await SCShareableContent.excludingDesktopWindows(
                    false, onScreenWindowsOnly: true
                )
            } catch {
                // This is almost always a TCC denial. Surface it loudly so
                // the bridge can relay it to the user.
                logErr("capture:permission-denied \(error.localizedDescription)")
                throw error
            }
            for w in content.windows {
                guard let app = w.owningApplication else { continue }
                if SIM_BUNDLE_IDS.contains(app.bundleIdentifier),
                   w.frame.width >= 200, w.frame.height >= 300 {
                    logErr("capture:window-found \(Int(w.frame.width))x\(Int(w.frame.height))")
                    return w
                }
            }
            logErr("capture:waiting-for-window attempt=\(attempt)/12")
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }
        throw NSError(
            domain: "sim-grab-capture", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "simulator window not found"]
        )
    }

    func start() async throws {
        let win = try await findWindow()
        self.window = win

        let filter = SCContentFilter(desktopIndependentWindow: win)
        let config = SCStreamConfiguration()
        let scale = NSScreen.main?.backingScaleFactor ?? 2.0

        // Capture at native resolution, we downscale before JPEG encode if
        // MAX_WIDTH asks us to. Keeping stream output high-res means the
        // downscale is a clean GPU pass instead of a blurry CA layer hit.
        config.width = Int(win.frame.width * scale)
        config.height = Int(win.frame.height * scale)
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(FPS))
        config.queueDepth = 3
        config.showsCursor = false
        config.capturesAudio = false

        logErr("capture:config \(config.width)x\(config.height) @ \(FPS)fps q=\(QUALITY) maxW=\(MAX_WIDTH)")

        // Announce the stream up front so the bridge can relay dimensions
        // to the browser before the first JPEG lands.
        writer.writeJSON([
            "type": "meta",
            "width": config.width,
            "height": config.height,
            "pointWidth": Int(win.frame.width),
            "pointHeight": Int(win.frame.height),
            "fps": FPS,
        ])

        let s = SCStream(filter: filter, configuration: config, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue.global(qos: .userInteractive))
        try await s.startCapture()
        self.stream = s
        logErr("capture:ready")
    }

    func stop() async {
        guard let s = stream else { return }
        do { try await s.stopCapture() } catch { /* best effort */ }
        stream = nil
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid else { return }

        // Frame validity — SCStream also emits "idle" / "blank" frames we
        // should drop, otherwise the browser sees a stutter from re-paints
        // of identical content.
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let first = attachments.first,
              let statusRaw = first[.status] as? Int,
              let status = SCFrameStatus(rawValue: statusRaw),
              status == .complete else {
            return
        }

        guard let pbuf = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        var ci = CIImage(cvPixelBuffer: pbuf)

        // Downscale if the window is gigantic. Keeps JPEG byte size sane
        // and network backpressure in check. The browser does its own
        // letterboxing, and the AX tree stays the source of truth for
        // tap coordinates, so we don't care about exact dimensions.
        let origW = Int(ci.extent.width)
        if MAX_WIDTH > 0 && origW > MAX_WIDTH {
            let scale = CGFloat(MAX_WIDTH) / CGFloat(origW)
            ci = ci.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }

        guard let jpeg = ciContext.jpegRepresentation(
            of: ci,
            colorSpace: colorSpace,
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: QUALITY]
        ) else { return }

        // Announce dimension change (e.g. user rotated the sim / resized
        // the window). Cheap: stringified 2-tuple compare.
        let dims = (Int(ci.extent.width), Int(ci.extent.height))
        if lastSentDims == nil || lastSentDims! != dims {
            writer.writeJSON([
                "type": "resize",
                "width": dims.0,
                "height": dims.1,
            ])
            lastSentDims = dims
        }

        writer.write(jpeg)

        frameCount += 1
        let now = Date()
        if now.timeIntervalSince(lastLog) >= 5 {
            logErr("capture:fps \(Double(frameCount) / now.timeIntervalSince(lastLog))")
            frameCount = 0
            lastLog = now
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        logErr("capture:stopped \(error.localizedDescription)")
        exit(2)
    }
}

// --- lifecycle --------------------------------------------------------------

let capture = Capture()

// Exit cleanly when the bridge dies or Ctrl-C.
signal(SIGTERM) { _ in exit(0) }
signal(SIGINT)  { _ in exit(0) }
signal(SIGPIPE) { _ in exit(0) }

// If stdin hits EOF, the parent is gone — stop.
DispatchQueue.global(qos: .utility).async {
    let buf = UnsafeMutableRawPointer.allocate(byteCount: 64, alignment: 1)
    defer { buf.deallocate() }
    while true {
        let n = read(0, buf, 64)
        if n <= 0 { exit(0) }
    }
}

Task {
    do {
        try await capture.start()
    } catch {
        logErr("capture:fatal \(error.localizedDescription)")
        exit(3)
    }
}

// Keep the process alive; SCStream delivers on its own queue.
RunLoop.main.run()
