import SwiftUI

/// Renders a loader's content, a spinner on first load, or an error with retry.
struct Loaded<Value, Content: View>: View {
    let loader: Loader<Value>
    var retry: (() async -> Void)? = nil
    @ViewBuilder let content: (Value) -> Content

    var body: some View {
        if let value = loader.value {
            content(value)
        } else if let error = loader.error {
            ErrorState(message: error, retry: retry)
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

struct ErrorState: View {
    let message: String
    var retry: (() async -> Void)? = nil

    var body: some View {
        ContentUnavailableView {
            Label("Could not load", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            if let retry {
                Button("Retry") { Task { await retry() } }.buttonStyle(.borderedProminent)
            }
        }
    }
}

struct EmptyState: View {
    let title: String
    var systemImage: String = "tray"
    var message: String? = nil

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            if let message { Text(message) }
        }
    }
}

enum Tone {
    case ok, warning, critical, muted, info

    var color: Color {
        switch self {
        case .ok: .green
        case .warning: .orange
        case .critical: .red
        case .muted: .secondary
        case .info: .blue
        }
    }
}

struct StatusDot: View {
    let tone: Tone
    var body: some View {
        Circle().fill(tone.color).frame(width: 9, height: 9)
    }
}

struct Badge: View {
    let text: String
    var tone: Tone = .muted

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(tone.color.opacity(0.15), in: Capsule())
            .foregroundStyle(tone.color)
    }
}

struct KeyValue: View {
    let key: String
    let value: String
    var mono = false

    init(_ key: String, _ value: String?, mono: Bool = false) {
        self.key = key
        self.value = (value?.isEmpty ?? true) ? "–" : value!
        self.mono = mono
    }

    var body: some View {
        HStack(alignment: .top) {
            Text(key).foregroundStyle(.secondary)
            Spacer(minLength: 16)
            Text(value)
                .font(mono ? .system(.footnote, design: .monospaced) : .body)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
    }
}

struct StatTile: View {
    let label: String
    let value: String
    var detail: String? = nil
    var tone: Tone? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value)
                .font(.title3.weight(.semibold).monospacedDigit())
                .foregroundStyle(tone?.color ?? .primary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            if let detail {
                Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

struct UsageBar: View {
    let fraction: Double
    var body: some View {
        let tone: Tone = fraction > 0.9 ? .critical : fraction > 0.75 ? .warning : .info
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color(.tertiarySystemFill))
                Capsule().fill(tone.color).frame(width: max(0, min(1, fraction)) * geo.size.width)
            }
        }
        .frame(height: 6)
    }
}

struct StreamStatusLabel: View {
    let status: StreamClient.Status
    let error: String?

    var body: some View {
        HStack(spacing: 6) {
            switch status {
            case .connecting:
                ProgressView().controlSize(.mini)
                Text("Connecting…")
            case .open:
                StatusDot(tone: .ok)
                Text("Live")
            case .closed:
                StatusDot(tone: .muted)
                Text("Ended")
            case .error:
                StatusDot(tone: .critical)
                Text(error ?? "Error").lineLimit(1)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

/// Shows an action error as an alert; bound through `ActionRunner`.
@MainActor
@Observable
final class ActionRunner {
    var busy = false
    var error: String?
    var showError = false

    func run(_ op: @escaping () async throws -> Void, then refresh: (() async -> Void)? = nil) {
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await op()
                await refresh?()
            } catch {
                self.error = error.localizedDescription
                self.showError = true
            }
        }
    }
}

extension View {
    func actionErrorAlert(_ runner: ActionRunner) -> some View {
        modifier(ActionErrorAlert(runner: runner))
    }
}

private struct ActionErrorAlert: ViewModifier {
    @Bindable var runner: ActionRunner
    func body(content: Content) -> some View {
        content.alert("Action failed", isPresented: $runner.showError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(runner.error ?? "Unknown error")
        }
    }
}

func serviceTone(active: String) -> Tone {
    switch active {
    case "active": .ok
    case "failed": .critical
    case "activating", "deactivating", "reloading": .warning
    default: .muted
    }
}

func containerTone(state: String) -> Tone {
    switch state {
    case "running": .ok
    case "paused": .info
    case "restarting", "created": .warning
    case "dead", "exited": .muted
    default: .muted
    }
}

func podTone(status: String) -> Tone {
    switch status {
    case "Running", "Succeeded", "Completed": .ok
    case "Pending", "ContainerCreating", "Terminating", "PodInitializing": .warning
    default: status.contains("Error") || status.contains("BackOff") || status == "Failed" || status.contains("OOM") ? .critical : .muted
    }
}

func httpTone(status: Int) -> Tone {
    status >= 500 ? .critical : status >= 400 ? .warning : status >= 300 ? .info : .ok
}
