import SwiftUI

/// Live view of requests reaching the nginx ingress controller.
struct RequestsView: View {
    @Environment(Session.self) private var session
    @State private var entries: [AccessEntry] = []
    @State private var stream: StreamClient?
    @State private var search = ""
    @State private var errorsOnly = false
    @State private var includePanel = false
    @State private var selected: AccessEntry?

    private struct Message: Decodable {
        let type: String
        let items: [AccessEntry]?
    }

    private var panelHost: String { URL(string: session.serverURL)?.host ?? "" }

    private var visible: [AccessEntry] {
        entries.filter { e in
            (includePanel || e.host != panelHost) &&
            (!errorsOnly || e.status >= 400) &&
            (search.isEmpty || e.path.localizedCaseInsensitiveContains(search) || e.host.localizedCaseInsensitiveContains(search)
             || e.service.localizedCaseInsensitiveContains(search) || e.client.contains(search) || String(e.status) == search)
        }
    }

    var body: some View {
        let list = visible
        let total = list.count
        let ok = list.filter { $0.status < 400 }.count
        let client = list.filter { (400..<500).contains($0.status) }.count
        let server = list.filter { $0.status >= 500 }.count
        List {
            Section {
                HStack {
                    StatTile(label: "Requests", value: "\(total)")
                    StatTile(label: "OK", value: "\(ok)", tone: .ok)
                    StatTile(label: "4xx", value: "\(client)", tone: client > 0 ? .warning : nil)
                    StatTile(label: "5xx", value: "\(server)", tone: server > 0 ? .critical : nil)
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
            Section {
                ForEach(list) { e in
                    Button { selected = e } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 8) {
                                Badge(text: "\(e.status)", tone: httpTone(status: e.status))
                                Text(e.method).font(.caption.weight(.semibold))
                                Text(e.path).font(.system(.caption, design: .monospaced)).lineLimit(1)
                                Spacer()
                                Text(Format.clock(ms: e.ts)).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                            }
                            HStack(spacing: 8) {
                                Text(e.host)
                                if !e.service.isEmpty { Text("→ \(e.service)") }
                                Spacer()
                                Text(Format.ms(e.duration))
                                Text(Format.bytes(e.bytes))
                            }
                            .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                HStack {
                    Toggle("Errors only", isOn: $errorsOnly)
                    Toggle("Include panel", isOn: $includePanel)
                }
                .toggleStyle(.button).font(.caption2).controlSize(.mini)
            }
        }
        .overlay {
            if list.isEmpty {
                if entries.isEmpty, stream?.status == .connecting { ProgressView() }
                else { EmptyState(title: entries.isEmpty ? "No requests yet" : "No requests match", systemImage: "network") }
            }
        }
        .searchable(text: $search, prompt: "Path, host, service, client or status")
        .navigationTitle("Requests")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let stream { StreamStatusLabel(status: stream.status, error: stream.error) }
            }
        }
        .sheet(item: $selected) { e in RequestDetail(entry: e) }
        .onAppear(perform: start)
        .onDisappear { stream?.stop(); stream = nil }
    }

    private func start() {
        guard stream == nil else { return }
        let client = StreamClient(api: session.api, request: ["channel": "ingress-requests", "tail": 1000]) {
            entries = []
        } onMessage: { data in
            guard let msg = try? JSONDecoder().decode(Message.self, from: data), msg.type == "requests", let items = msg.items else { return }
            entries.insert(contentsOf: items.reversed(), at: 0)
            if entries.count > 2000 { entries.removeLast(entries.count - 2000) }
        }
        stream = client
        client.start()
    }
}

extension AccessEntry: Hashable {
    static func == (a: AccessEntry, b: AccessEntry) -> Bool { a.id == b.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

private struct RequestDetail: View {
    let entry: AccessEntry
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    KeyValue("Time", Format.dateTime(ms: entry.ts))
                    KeyValue("Status", "\(entry.status)")
                    KeyValue("Method", entry.method)
                    KeyValue("Path", entry.path, mono: true)
                    KeyValue("Host", entry.host, mono: true)
                    KeyValue("Protocol", entry.protocol)
                }
                Section("Routing") {
                    KeyValue("Namespace", entry.namespace)
                    KeyValue("Service", entry.service)
                    KeyValue("Upstream", entry.upstream, mono: true)
                    KeyValue("Upstream status", entry.upstreamStatus.map(String.init))
                    KeyValue("Duration", Format.ms(entry.duration))
                    KeyValue("Size", Format.bytes(entry.bytes))
                }
                Section("Client") {
                    KeyValue("Address", entry.client, mono: true)
                    KeyValue("Referer", entry.referer, mono: true)
                    KeyValue("User agent", entry.userAgent)
                }
            }
            .navigationTitle("Request")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
