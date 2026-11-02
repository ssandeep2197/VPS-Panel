import Foundation

enum Format {
    private static let units = ["B", "KB", "MB", "GB", "TB", "PB"]

    static func bytes(_ value: Double?, digits: Int = 1) -> String {
        guard let value, value.isFinite else { return "–" }
        if value < 1 { return "0 B" }
        let i = min(units.count - 1, Int(log(value) / log(1024)))
        let scaled = value / pow(1024, Double(i))
        let d = (i == 0 || scaled >= 100) ? 0 : digits
        return String(format: "%.\(d)f %@", scaled, units[i])
    }

    static func rate(_ bytesPerSec: Double) -> String { bytes(bytesPerSec) + "/s" }

    static func percent(_ value: Double, digits: Int = 1) -> String {
        String(format: "%.\(digits)f%%", value)
    }

    static func number(_ value: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: value)) ?? String(Int(value))
    }

    static func duration(_ seconds: Double) -> String {
        let s = Int(seconds)
        let d = s / 86400
        let h = (s % 86400) / 3600
        let m = (s % 3600) / 60
        if d > 0 { return "\(d)d \(h)h" }
        if h > 0 { return "\(h)h \(m)m" }
        return "\(m)m"
    }

    static func cpuSeconds(_ seconds: Double) -> String {
        if seconds < 60 { return String(format: "%.1fs", seconds) }
        return duration(seconds)
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func date(_ value: String?) -> Date? {
        guard let value, !value.isEmpty, !value.hasPrefix("0001-") else { return nil }
        return iso.date(from: value) ?? isoPlain.date(from: value)
    }

    static func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }

    static func ago(_ date: Date?) -> String {
        guard let date else { return "–" }
        let s = max(0, Int(Date().timeIntervalSince(date).rounded()))
        if s < 60 { return "just now" }
        if s < 3600 { return "\(s / 60)m ago" }
        if s < 86400 { return "\(s / 3600)h ago" }
        if s < 86400 * 60 { return "\(s / 86400)d ago" }
        return date.formatted(date: .abbreviated, time: .omitted)
    }

    static func ago(_ iso: String?) -> String { ago(date(iso)) }
    static func ago(ms: Double) -> String { ago(date(ms)) }

    static func dateTime(_ date: Date?) -> String {
        guard let date else { return "–" }
        return date.formatted(date: .abbreviated, time: .standard)
    }

    static func dateTime(_ iso: String?) -> String { dateTime(date(iso)) }
    static func dateTime(ms: Double) -> String { dateTime(date(ms)) }

    static func clock(ms: Double) -> String {
        date(ms).formatted(date: .omitted, time: .standard)
    }

    static func ms(_ value: Double) -> String {
        value >= 1000 ? String(format: "%.2fs", value / 1000) : String(format: "%.0fms", value)
    }
}
