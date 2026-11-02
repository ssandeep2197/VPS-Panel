import SwiftUI

/// Live log viewer for any of the line-based WebSocket channels (service, container or pod logs).
struct LogView: View {
    @Environment(Session.self) private var session
    let title: String
    let request: [String: Any]

    @State private var lines: [Line] = []
    @State private var stream: StreamClient?
    @State private var follow = true
    @State private var filter = ""

    private struct Line: Identifiable {
        let id: Int
        let text: String
    }
    private struct Message: Decodable {
        let type: String
        let lines: [String]?
    }

    private var visible: [Line] {
        filter.isEmpty ? lines : lines.filter { $0.text.localizedCaseInsensitiveContains(filter) }
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView([.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(visible) { line in
                        Text(line.text)
                            .font(.system(size: 11, design: .monospaced))
                            .textSelection(.enabled)
                            .id(line.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(8)
            }
            .background(Color(.systemBackground))
            .onChange(of: lines.count) { _, _ in
                if follow { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .overlay(alignment: .center) {
                if lines.isEmpty, let stream, stream.status == .open {
                    Text("No output yet").foregroundStyle(.secondary)
                } else if lines.isEmpty, stream?.status == .connecting {
                    ProgressView()
                }
            }
        }
        .searchable(text: $filter, placement: .navigationBarDrawer(displayMode: .always), prompt: "Filter lines")
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let stream { StreamStatusLabel(status: stream.status, error: stream.error) }
                Toggle(isOn: $follow) { Image(systemName: "arrow.down.to.line") }
                    .toggleStyle(.button)
            }
        }
        .onAppear(perform: start)
        .onDisappear { stream?.stop(); stream = nil }
    }

    private func start() {
        guard stream == nil else { return }
        var counter = 0
        let client = StreamClient(api: session.api, request: request) {
            lines = []
        } onMessage: { data in
            guard let msg = try? JSONDecoder().decode(Message.self, from: data), msg.type == "lines", let new = msg.lines else { return }
            for text in new {
                counter += 1
                lines.append(Line(id: counter, text: text))
            }
            if lines.count > 3000 { lines.removeFirst(lines.count - 3000) }
        }
        stream = client
        client.start()
    }
}
