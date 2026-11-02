import SwiftUI

struct DockerView: View {
    @Environment(Session.self) private var session
    @State private var tab = Tab.containers
    @State private var info = Loader<DockerInfo>()

    enum Tab: String, CaseIterable { case containers = "Containers", images = "Images", volumes = "Volumes", networks = "Networks" }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Section", selection: $tab) {
                    ForEach(Tab.allCases, id: \.self) { Text($0.rawValue) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.bottom, 8)
                switch tab {
                case .containers: ContainersList(info: info.value)
                case .images: ImagesList()
                case .volumes: VolumesList()
                case .networks: NetworksList()
                }
            }
            .navigationTitle("Docker")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if let i = info.value {
                        Text("v\(i.version)").font(.caption).foregroundStyle(.secondary)
                    } else if let e = info.error {
                        Image(systemName: "exclamationmark.triangle").foregroundStyle(.red).help(e)
                    }
                }
            }
            .task { await info.poll(every: 30) { try await session.api.dockerInfo() } }
        }
    }
}

private struct ContainersList: View {
    @Environment(Session.self) private var session
    let info: DockerInfo?
    @State private var loader = Loader<[Container]>()
    @State private var stats: [String: ContainerStats] = [:]
    @State private var search = ""

    var body: some View {
        Loaded(loader: loader, retry: reload) { containers in
            let list = containers.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || $0.image.localizedCaseInsensitiveContains(search) }
            let groups = Dictionary(grouping: list) { $0.project ?? "" }
            List {
                if let info {
                    Section {
                        HStack {
                            StatTile(label: "Running", value: "\(info.running)", tone: .ok)
                            StatTile(label: "Stopped", value: "\(info.stopped)")
                            StatTile(label: "Paused", value: "\(info.paused)")
                            StatTile(label: "Images", value: "\(info.images)")
                        }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    }
                }
                ForEach(sortedProjects(groups), id: \.self) { project in
                    Section(project.isEmpty ? (groups.count > 1 ? "Standalone" : "Containers") : project) {
                        ForEach(groups[project] ?? []) { c in
                            NavigationLink(value: c) { ContainerRow(container: c, stats: stats[c.id]) }
                        }
                    }
                }
            }
            .overlay { if list.isEmpty { EmptyState(title: "No containers", systemImage: "shippingbox") } }
        }
        .searchable(text: $search, prompt: "Search containers")
        .navigationDestination(for: Container.self) { ContainerDetailView(container: $0) }
        .refreshable { await reload() }
        .task { await loader.poll(every: 5) { try await session.api.containers() } }
        .task {
            while !Task.isCancelled {
                if let s = try? await session.api.containerStats() { stats = s }
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    private func sortedProjects(_ groups: [String: [Container]]) -> [String] {
        groups.keys.sorted { a, b in
            if a.isEmpty != b.isEmpty { return b.isEmpty }
            return a < b
        }
    }

    private func reload() async { await loader.load { try await session.api.containers() } }
}

extension Container: Hashable {
    static func == (a: Container, b: Container) -> Bool { a.id == b.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

private struct ContainerRow: View {
    let container: Container
    let stats: ContainerStats?

    var body: some View {
        HStack(spacing: 10) {
            StatusDot(tone: containerTone(state: container.state))
            VStack(alignment: .leading, spacing: 2) {
                Text(container.name).font(.body.weight(.medium)).lineLimit(1)
                Text(container.image).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Text(container.status).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if let s = stats {
                VStack(alignment: .trailing, spacing: 2) {
                    Text(Format.percent(s.cpu)).font(.caption.monospacedDigit())
                    Text(Format.bytes(s.memUsed)).font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct ContainerDetailView: View {
    @Environment(Session.self) private var session
    let container: Container
    @State private var loader = Loader<ContainerDetail>()
    @State private var runner = ActionRunner()
    @State private var pending: ContainerAction?
    @State private var confirmRemove = false

    var body: some View {
        Loaded(loader: loader, retry: reload) { d in
            List {
                Section {
                    HStack(spacing: 10) {
                        StatusDot(tone: containerTone(state: d.state))
                        Text(d.state.capitalized)
                        if let h = d.health { Badge(text: h, tone: h == "healthy" ? .ok : h == "unhealthy" ? .critical : .warning) }
                        Spacer()
                        Text(container.status).font(.caption).foregroundStyle(.secondary)
                    }
                    Text(d.image).font(.footnote).foregroundStyle(.secondary).textSelection(.enabled)
                }
                Section("Actions") {
                    HStack {
                        if d.state == "running" {
                            button(.restart, "arrow.clockwise")
                            button(.stop, "stop.fill")
                            button(.pause, "pause.fill")
                        } else if d.state == "paused" {
                            button(.unpause, "play.fill")
                        } else {
                            button(.start, "play.fill")
                        }
                        Spacer()
                        Button(role: .destructive) { confirmRemove = true } label: { Label("Remove", systemImage: "trash") }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(runner.busy)
                    NavigationLink {
                        LogView(title: container.name, request: ["channel": "docker-logs", "id": container.id, "tail": 300])
                    } label: { Label("Live logs", systemImage: "doc.text.magnifyingglass") }
                }
                Section("Details") {
                    KeyValue("ID", String(d.id.prefix(12)), mono: true)
                    KeyValue("Command", d.command, mono: true)
                    KeyValue("Created", Format.dateTime(d.created))
                    KeyValue("Started", Format.dateTime(d.startedAt))
                    if d.state != "running" {
                        KeyValue("Finished", Format.dateTime(d.finishedAt))
                        KeyValue("Exit code", String(d.exitCode))
                    }
                    KeyValue("Restart policy", d.restartPolicy)
                    KeyValue("Restarts", String(d.restartCount))
                }
                if !d.ports.isEmpty {
                    Section("Ports") { ForEach(d.ports, id: \.self) { Text($0).font(.system(.footnote, design: .monospaced)) } }
                }
                if !d.networks.isEmpty {
                    Section("Networks") { ForEach(d.networks) { KeyValue($0.name, $0.ip, mono: true) } }
                }
                if !d.mounts.isEmpty {
                    Section("Mounts") {
                        ForEach(d.mounts) { m in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(m.destination).font(.system(.footnote, design: .monospaced))
                                Text("\(m.type) · \(m.source) · \(m.rw ? "rw" : "ro")").font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if !d.envNames.isEmpty {
                    Section("Environment (names only)") {
                        Text(d.envNames.joined(separator: ", ")).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle(container.name)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .task { await loader.poll(every: 10) { try await session.api.container(container.id) } }
        .actionErrorAlert(runner)
        .confirmationDialog("\(pending?.rawValue.capitalized ?? "") \(container.name)?",
                            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
                            titleVisibility: .visible) {
            if let action = pending {
                Button(action.rawValue.capitalized, role: action == .stop || action == .kill ? .destructive : nil) {
                    runner.run({ try await session.api.containerAction(container.id, action, name: container.name) }, then: reload)
                }
            }
        }
        .confirmationDialog("Remove \(container.name)?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove (force)", role: .destructive) {
                runner.run { try await session.api.removeContainer(container.id, force: true) }
            }
        } message: { Text("The container and its writable layer are deleted. Volumes are kept.") }
    }

    private func button(_ action: ContainerAction, _ icon: String) -> some View {
        Button { pending = action } label: { Label(action.rawValue.capitalized, systemImage: icon) }
    }

    private func reload() async { await loader.load { try await session.api.container(container.id) } }
}

private struct ImagesList: View {
    @Environment(Session.self) private var session
    @State private var loader = Loader<[DockerImage]>()
    @State private var runner = ActionRunner()
    @State private var toRemove: DockerImage?

    var body: some View {
        Loaded(loader: loader, retry: reload) { images in
            List {
                ForEach(images) { img in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(img.tags.first ?? "<none>").font(.body.weight(.medium)).lineLimit(1)
                        if img.tags.count > 1 { Text(img.tags.dropFirst().joined(separator: ", ")).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        HStack {
                            Text(Format.bytes(img.size))
                            Text("·")
                            Text(Format.ago(ms: img.created))
                            Spacer()
                            if img.inUse { Badge(text: "in use", tone: .ok) } else { Badge(text: "unused") }
                        }
                        .font(.caption).foregroundStyle(.secondary)
                    }
                    .swipeActions {
                        if !img.inUse { Button(role: .destructive) { toRemove = img } label: { Label("Remove", systemImage: "trash") } }
                    }
                }
            }
            .overlay { if images.isEmpty { EmptyState(title: "No images") } }
        }
        .refreshable { await reload() }
        .task { await reload() }
        .actionErrorAlert(runner)
        .confirmationDialog("Remove image \(toRemove?.tags.first ?? String(toRemove?.id.prefix(19) ?? ""))?",
                            isPresented: Binding(get: { toRemove != nil }, set: { if !$0 { toRemove = nil } }), titleVisibility: .visible) {
            if let img = toRemove {
                Button("Remove", role: .destructive) { runner.run({ try await session.api.removeImage(img.id, force: false) }, then: reload) }
            }
        }
    }

    private func reload() async { await loader.load { try await session.api.images() } }
}

private struct VolumesList: View {
    @Environment(Session.self) private var session
    @State private var loader = Loader<[DockerVolume]>()

    var body: some View {
        Loaded(loader: loader, retry: reload) { volumes in
            List(volumes) { v in
                VStack(alignment: .leading, spacing: 2) {
                    Text(v.name).font(.body.weight(.medium)).lineLimit(1)
                    Text(v.mountpoint).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    HStack {
                        Text(v.driver)
                        if let c = v.created { Text("· \(Format.ago(c))") }
                        Spacer()
                        if v.usedBy.isEmpty { Badge(text: "unused") } else { Badge(text: v.usedBy.joined(separator: ", "), tone: .ok) }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
            }
            .overlay { if volumes.isEmpty { EmptyState(title: "No volumes") } }
        }
        .refreshable { await reload() }
        .task { await reload() }
    }

    private func reload() async { await loader.load { try await session.api.volumes() } }
}

private struct NetworksList: View {
    @Environment(Session.self) private var session
    @State private var loader = Loader<[DockerNetwork]>()

    var body: some View {
        Loaded(loader: loader, retry: reload) { networks in
            List(networks) { n in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(n.name).font(.body.weight(.medium))
                        Text("\(n.driver) · \(n.scope)\(n.isInternal ? " · internal" : "")").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(n.subnet ?? "–").font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                }
            }
            .overlay { if networks.isEmpty { EmptyState(title: "No networks") } }
        }
        .refreshable { await reload() }
        .task { await reload() }
    }

    private func reload() async { await loader.load { try await session.api.networks() } }
}
