import SwiftUI

struct ActivityView: View {
    @Environment(Session.self) private var session
    @State private var loader = Loader<[AuditEntry]>()
    @State private var search = ""
    @State private var failedOnly = false

    private func filtered(_ entries: [AuditEntry]) -> [AuditEntry] {
        entries.filter { e in
            if failedOnly && e.ok { return false }
            if search.isEmpty { return true }
            return e.action.localizedCaseInsensitiveContains(search)
                || e.target.localizedCaseInsensitiveContains(search)
                || e.user.localizedCaseInsensitiveContains(search)
                || e.ip.contains(search)
        }
    }

    var body: some View {
        Loaded(loader: loader, retry: reload) { entries in
            let list = filtered(entries)
            List {
                Section {
                    ForEach(list) { AuditRow(entry: $0) }
                } header: {
                    HStack {
                        Text("\(list.count) entries")
                        Spacer()
                        Toggle("Failed only", isOn: $failedOnly).toggleStyle(.button).font(.caption2).controlSize(.mini)
                    }
                }
            }
            .overlay { if list.isEmpty { EmptyState(title: "No activity") } }
        }
        .searchable(text: $search, prompt: "Action, target, user or IP")
        .navigationTitle("Activity")
        .refreshable { await reload() }
        .task { await loader.poll(every: 15) { try await session.api.audit() } }
    }

    private func reload() async { await loader.load { try await session.api.audit() } }
}

private struct AuditRow: View {
    let entry: AuditEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                StatusDot(tone: entry.ok ? .ok : .critical)
                Text(entry.action).font(.footnote.weight(.semibold))
                Text(entry.target).font(.system(.footnote, design: .monospaced)).lineLimit(1)
                Spacer()
                Text(Format.ago(entry.ts)).font(.caption2).foregroundStyle(.secondary)
            }
            HStack {
                Text(entry.user + " from " + entry.ip)
                Spacer()
                Text(Format.dateTime(entry.ts))
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            if let detail = entry.detail, !detail.isEmpty {
                Text(detail).font(.caption).foregroundStyle(entry.ok ? Color.secondary : Color.red)
            }
        }
    }
}
