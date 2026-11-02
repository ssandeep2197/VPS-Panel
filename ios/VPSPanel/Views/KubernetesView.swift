import SwiftUI

struct KubernetesView: View {
    @State private var tab = Tab.apps

    enum Tab: String, CaseIterable { case apps = "Apps", pods = "Pods", ingresses = "Ingresses", warnings = "Warnings" }

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
                case .apps: WorkloadsList()
                case .pods: PodsList()
                case .ingresses: IngressesList()
                case .warnings: EventsList()
                }
            }
            .navigationTitle("Kubernetes")
        }
    }
}

private struct WorkloadsList: View {
    @Environment(Session.self) private var session
    @State private var loader = Loader<[K8sWorkload]>()
    @State private var overview = Loader<K8sOverview>()
    @State private var runner = ActionRunner()
    @State private var restartTarget: K8sWorkload?
    @State private var scaleTarget: K8sWorkload?
    @State private var replicas = 1
    @State private var search = ""

    var body: some View {
        Loaded(loader: loader, retry: reload) { workloads in
            let list = workloads.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || $0.namespace.localizedCaseInsensitiveContains(search) }
            let groups = Dictionary(grouping: list, by: \.namespace)
            List {
                if let o = overview.value {
                    Section("Nodes") {
                        ForEach(o.nodes) { n in
                            HStack {
                                StatusDot(tone: n.ready ? .ok : .critical)
                                Text(n.name).font(.body.weight(.medium))
                                Spacer()
                                Text("\(n.roles.joined(separator: ",")) · \(n.version)").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                ForEach(groups.keys.sorted(), id: \.self) { ns in
                    Section(ns) {
                        ForEach(groups[ns] ?? []) { w in
                            let healthy = w.ready >= w.desired && w.desired > 0
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    StatusDot(tone: w.desired == 0 ? .muted : healthy ? .ok : .warning)
                                    Text(w.name).font(.body.weight(.medium)).lineLimit(1)
                                    Spacer()
                                    Text("\(w.ready)/\(w.desired)").font(.caption.monospacedDigit())
                                    Badge(text: w.kind)
                                }
                                Text(w.images.joined(separator: ", ")).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                            .swipeActions(edge: .trailing) {
                                Button { restartTarget = w } label: { Label("Restart", systemImage: "arrow.clockwise") }.tint(.blue)
                                if w.scalable { Button { replicas = w.desired; scaleTarget = w } label: { Label("Scale", systemImage: "arrow.up.arrow.down") }.tint(.orange) }
                            }
                        }
                    }
                }
            }
            .overlay { if list.isEmpty { EmptyState(title: "No workloads") } }
        }
        .searchable(text: $search, prompt: "Search apps")
        .refreshable { await reload() }
        .task { await loader.poll(every: 10) { try await session.api.k8sWorkloads() } }
        .task { await overview.load { try await session.api.k8sOverview() } }
        .actionErrorAlert(runner)
        .confirmationDialog("Restart \(restartTarget?.name ?? "")?", isPresented: Binding(get: { restartTarget != nil }, set: { if !$0 { restartTarget = nil } }), titleVisibility: .visible) {
            if let w = restartTarget {
                Button("Rolling restart") { runner.run({ try await session.api.k8sRestart(w) }, then: reload) }
            }
        } message: { Text("Pods are replaced one by one.") }
        .sheet(item: $scaleTarget) { w in
            NavigationStack {
                Form {
                    Stepper("Replicas: \(replicas)", value: $replicas, in: 0...50)
                    if replicas == 0 { Text("Scaling to 0 stops the app.").foregroundStyle(.orange).font(.footnote) }
                }
                .navigationTitle("Scale \(w.name)")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { scaleTarget = nil } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Apply") {
                            let r = replicas
                            scaleTarget = nil
                            runner.run({ try await session.api.k8sScale(w, replicas: r) }, then: reload)
                        }
                    }
                }
            }
            .presentationDetents([.height(220)])
        }
    }

    private func reload() async { await loader.load { try await session.api.k8sWorkloads() } }
}

extension K8sWorkload: Hashable {
    static func == (a: K8sWorkload, b: K8sWorkload) -> Bool { a.id == b.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

extension K8sPod: Hashable {
    static func == (a: K8sPod, b: K8sPod) -> Bool { a.id == b.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

private struct PodsList: View {
    @Environment(Session.self) private var session
    @State private var loader = Loader<[K8sPod]>()
    @State private var search = ""

    var body: some View {
        Loaded(loader: loader, retry: reload) { pods in
            let list = pods.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || $0.namespace.localizedCaseInsensitiveContains(search) }
            let groups = Dictionary(grouping: list, by: \.namespace)
            List {
                ForEach(groups.keys.sorted(), id: \.self) { ns in
                    Section(ns) {
                        ForEach(groups[ns] ?? []) { p in
                            NavigationLink(value: p) {
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack {
                                        StatusDot(tone: podTone(status: p.status))
                                        Text(p.name).font(.footnote.weight(.medium)).lineLimit(1)
                                    }
                                    HStack(spacing: 8) {
                                        Text(p.status)
                                        Text("\(p.ready)/\(p.total) ready")
                                        if p.restarts > 0 { Text("\(p.restarts) restarts").foregroundStyle(p.restarts > 5 ? .orange : .secondary) }
                                        Spacer()
                                        if let cpu = p.cpuMilli { Text("\(Int(cpu))m") }
                                        if let mem = p.memory { Text(Format.bytes(mem)) }
                                    }
                                    .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .overlay { if list.isEmpty { EmptyState(title: "No pods") } }
        }
        .searchable(text: $search, prompt: "Search pods")
        .navigationDestination(for: K8sPod.self) { PodDetailView(pod: $0) }
        .refreshable { await reload() }
        .task { await loader.poll(every: 10) { try await session.api.k8sPods() } }
    }

    private func reload() async { await loader.load { try await session.api.k8sPods() } }
}

struct PodDetailView: View {
    @Environment(Session.self) private var session
    @Environment(\.dismiss) private var dismiss
    let pod: K8sPod
    @State private var runner = ActionRunner()
    @State private var confirmDelete = false

    var body: some View {
        List {
            Section {
                HStack {
                    StatusDot(tone: podTone(status: pod.status))
                    Text(pod.status)
                    Spacer()
                    Text("\(pod.ready)/\(pod.total) ready").font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("Logs") {
                ForEach(pod.containers) { c in
                    NavigationLink {
                        LogView(title: c.name, request: ["channel": "pod-logs", "namespace": pod.namespace, "pod": pod.name, "container": c.name, "tail": 300])
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Label(c.name, systemImage: "doc.text.magnifyingglass")
                            Text(c.image).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
            }
            Section("Details") {
                KeyValue("Namespace", pod.namespace)
                KeyValue("Phase", pod.phase)
                KeyValue("Owner", pod.owner)
                KeyValue("Node", pod.node)
                KeyValue("Pod IP", pod.ip, mono: true)
                KeyValue("Restarts", String(pod.restarts))
                KeyValue("CPU", pod.cpuMilli.map { "\(Int($0))m" })
                KeyValue("Memory", pod.memory.map { Format.bytes($0) })
                KeyValue("Created", Format.dateTime(pod.created))
            }
            Section {
                Button("Delete pod", role: .destructive) { confirmDelete = true }.disabled(runner.busy)
            } footer: {
                Text(pod.owner != nil
                     ? "The controller (\(pod.owner!)) recreates the pod. Use this to force a restart."
                     : "This pod is not managed by a controller and will not be recreated.")
            }
        }
        .navigationTitle(pod.name)
        .navigationBarTitleDisplayMode(.inline)
        .actionErrorAlert(runner)
        .confirmationDialog("Delete \(pod.name)?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                runner.run({ try await session.api.k8sDeletePod(pod) }, then: { dismiss() })
            }
        }
    }
}

private struct IngressesList: View {
    @Environment(Session.self) private var session
    @State private var loader = Loader<[K8sIngress]>()

    var body: some View {
        Loaded(loader: loader, retry: reload) { ingresses in
            List(ingresses) { ing in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(ing.name).font(.body.weight(.medium))
                        Spacer()
                        Text(ing.namespace).font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(ing.hosts) { h in
                        HStack(spacing: 6) {
                            Image(systemName: h.tls ? "lock.fill" : "lock.open").font(.caption2).foregroundStyle(h.tls ? .green : .orange)
                            Text(h.host).font(.system(.footnote, design: .monospaced))
                        }
                    }
                    Text("→ \(ing.backends.joined(separator: ", "))").font(.caption).foregroundStyle(.secondary)
                    if let cert = ing.certificate {
                        HStack(spacing: 6) {
                            StatusDot(tone: cert.ready ? .ok : .critical)
                            Text(cert.ready ? "Certificate ready" : cert.message).font(.caption)
                            if let exp = cert.expires { Text("· expires \(Format.ago(exp).replacingOccurrences(of: " ago", with: ""))").font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
            }
            .overlay { if ingresses.isEmpty { EmptyState(title: "No ingresses") } }
        }
        .refreshable { await reload() }
        .task { await reload() }
    }

    private func reload() async { await loader.load { try await session.api.k8sIngresses() } }
}

private struct EventsList: View {
    @Environment(Session.self) private var session
    @State private var loader = Loader<[K8sEvent]>()

    var body: some View {
        Loaded(loader: loader, retry: reload) { events in
            List(events) { e in
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Badge(text: e.reason, tone: .warning)
                        Text(e.object).font(.footnote.weight(.medium)).lineLimit(1)
                        Spacer()
                        Text(Format.ago(e.lastSeen)).font(.caption2).foregroundStyle(.secondary)
                    }
                    Text(e.message).font(.caption).foregroundStyle(.secondary)
                    Text("\(e.namespace) · ×\(e.count)").font(.caption2).foregroundStyle(.tertiary)
                }
            }
            .overlay { if events.isEmpty { EmptyState(title: "No warnings", systemImage: "checkmark.seal", message: "The cluster reports no warning events.") } }
        }
        .refreshable { await reload() }
        .task { await loader.poll(every: 20) { try await session.api.k8sEvents() } }
    }

    private func reload() async { await loader.load { try await session.api.k8sEvents() } }
}
