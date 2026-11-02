import SwiftUI

struct ServicesView: View {
    @Environment(Session.self) private var session
    var embedded = false
    @State private var loader = Loader<[ServiceUnit]>()
    @State private var search = ""
    @State private var onlyActive = false

    private func filtered(_ units: [ServiceUnit]) -> [ServiceUnit] {
        units.filter { u in
            (!onlyActive || u.active == "active") &&
            (search.isEmpty || u.name.localizedCaseInsensitiveContains(search) || u.description.localizedCaseInsensitiveContains(search))
        }
    }

    var body: some View {
        if embedded { content } else { NavigationStack { content } }
    }

    private var content: some View {
        Group {
            Loaded(loader: loader, retry: reload) { units in
                let list = filtered(units)
                List {
                    Section {
                        ForEach(list) { unit in
                            NavigationLink(value: unit.name) {
                                HStack(spacing: 10) {
                                    StatusDot(tone: serviceTone(active: unit.active))
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack(spacing: 6) {
                                            Text(unit.name).font(.body.weight(.medium)).lineLimit(1)
                                            if unit.protected { Image(systemName: "lock.fill").font(.caption2).foregroundStyle(.secondary) }
                                        }
                                        Text(unit.description).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                    Spacer()
                                    VStack(alignment: .trailing, spacing: 2) {
                                        Text(unit.sub).font(.caption)
                                        Text(unit.enabled).font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    } header: {
                        let active = units.filter { $0.active == "active" }.count
                        let failed = units.filter { $0.active == "failed" }.count
                        Text("\(active) active · \(failed) failed · \(units.count) units")
                    }
                }
                .overlay { if list.isEmpty { EmptyState(title: "No services match") } }
            }
            .navigationTitle("Services")
            .navigationDestination(for: String.self) { ServiceDetailView(name: $0) }
            .searchable(text: $search, prompt: "Search units")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Toggle("Active only", isOn: $onlyActive).toggleStyle(.button).font(.caption)
                }
            }
            .refreshable { await reload() }
            .task { await loader.poll(every: 15) { try await session.api.services() } }
        }
    }

    private func reload() async { await loader.load { try await session.api.services() } }
}

struct ServiceDetailView: View {
    @Environment(Session.self) private var session
    let name: String
    @State private var loader = Loader<ServiceDetail>()
    @State private var runner = ActionRunner()
    @State private var pendingAction: ServiceAction?

    var body: some View {
        Loaded(loader: loader, retry: reload) { s in
            List {
                Section {
                    HStack(spacing: 10) {
                        StatusDot(tone: serviceTone(active: s.active))
                        Text("\(s.active) (\(s.sub))")
                        Spacer()
                        Badge(text: s.enabled, tone: s.enabled == "enabled" ? .ok : .muted)
                    }
                    Text(s.description).font(.footnote).foregroundStyle(.secondary)
                }
                Section("Actions") {
                    actionButtons(s)
                    NavigationLink {
                        LogView(title: name, request: ["channel": "service-logs", "name": name, "tail": 300])
                    } label: {
                        Label("Live logs", systemImage: "doc.text.magnifyingglass")
                    }
                }
                Section("Runtime") {
                    KeyValue("Main PID", s.mainPid.map(String.init))
                    KeyValue("Memory", s.memoryBytes.map { Format.bytes($0) })
                    KeyValue("CPU time", s.cpuSeconds.map { Format.cpuSeconds($0) })
                    KeyValue("Tasks", s.tasks.map(String.init))
                    KeyValue("Restarts", s.restarts.map(String.init))
                    KeyValue("Restart policy", s.restartPolicy)
                    KeyValue("Active since", s.activeSince.isEmpty ? nil : "\(s.activeSince)")
                    KeyValue("User", s.user)
                }
                Section("Unit") {
                    KeyValue("Unit file", s.unitFile, mono: true)
                    KeyValue("ExecStart", s.execStart, mono: true)
                    KeyValue("Load", s.load)
                }
            }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .task { await loader.poll(every: 10) { try await session.api.service(name) } }
        .actionErrorAlert(runner)
        .confirmationDialog(
            "\(pendingAction?.rawValue.capitalized ?? "") \(name)?",
            isPresented: Binding(get: { pendingAction != nil }, set: { if !$0 { pendingAction = nil } }),
            titleVisibility: .visible
        ) {
            if let action = pendingAction {
                Button(action.rawValue.capitalized, role: action == .stop || action == .disable ? .destructive : nil) {
                    runner.run({ _ = try await session.api.serviceAction(name, action) }, then: reload)
                }
            }
        }
    }

    @ViewBuilder private func actionButtons(_ s: ServiceDetail) -> some View {
        let running = s.active == "active"
        HStack {
            if running {
                button(.restart, "arrow.clockwise", s)
                button(.reload, "arrow.triangle.2.circlepath", s)
                button(.stop, "stop.fill", s)
            } else {
                button(.start, "play.fill", s)
            }
            Spacer()
            if s.enabled == "enabled" { button(.disable, "xmark.circle", s) } else { button(.enable, "checkmark.circle", s) }
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
        .disabled(runner.busy)
        if s.protected {
            Text("Protected: this service cannot be stopped or disabled from the panel.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func button(_ action: ServiceAction, _ icon: String, _ s: ServiceDetail) -> some View {
        Button { pendingAction = action } label: { Label(action.rawValue.capitalized, systemImage: icon) }
            .disabled(s.protected && (action == .stop || action == .disable))
    }

    private func reload() async { await loader.load { try await session.api.service(name) } }
}
