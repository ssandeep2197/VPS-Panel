import SwiftUI

struct KafkaView: View {
    @Environment(Session.self) private var session
    @State private var tab = Tab.topics
    @State private var cluster = Loader<KafkaCluster>()

    enum Tab: String, CaseIterable { case topics = "Topics", groups = "Consumer groups" }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Section", selection: $tab) {
                ForEach(Tab.allCases, id: \.self) { Text($0.rawValue) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.bottom, 8)
            switch tab {
            case .topics: TopicsList(cluster: cluster.value)
            case .groups: GroupsList()
            }
        }
        .navigationTitle("Kafka")
        .task { await cluster.load { try await session.api.kafkaCluster() } }
        .overlay {
            if let error = cluster.error, cluster.value == nil {
                ContentUnavailableView {
                    Label("Kafka unavailable", systemImage: "arrow.triangle.branch")
                } description: {
                    Text(error + "\n\nAfter changing server/.env, restart the panel (systemctl restart vps-panel), then pull down here to re-check.")
                } actions: {
                    Button("Re-check") {
                        Task {
                            await session.loadCapabilities()
                            await cluster.load { try await session.api.kafkaCluster() }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                }
                .background(Color(.systemGroupedBackground))
            }
        }
    }
}

private struct TopicsList: View {
    @Environment(Session.self) private var session
    let cluster: KafkaCluster?
    @State private var loader = Loader<[KafkaTopic]>()
    @State private var search = ""
    @State private var showInternal = false
    @State private var runner = ActionRunner()
    @State private var showCreate = false
    @State private var toDelete: KafkaTopic?

    var body: some View {
        Loaded(loader: loader, retry: reload) { topics in
            let list = topics.filter { (showInternal || !$0.isInternal) && (search.isEmpty || $0.name.localizedCaseInsensitiveContains(search)) }
            List {
                if let c = cluster {
                    Section("Cluster") {
                        KeyValue("Cluster ID", c.clusterId, mono: true)
                        ForEach(c.brokers) { b in
                            HStack {
                                StatusDot(tone: .ok)
                                Text("Broker \(b.nodeId)")
                                Spacer()
                                Text("\(b.host):\(b.port)").font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                                if b.isController { Badge(text: "controller", tone: .info) }
                            }
                        }
                    }
                }
                Section {
                    ForEach(list) { t in
                        NavigationLink(value: t.name) {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(t.name).font(.body.weight(.medium)).lineLimit(1)
                                    Spacer()
                                    Text(Format.number(t.messages)).font(.caption.monospacedDigit())
                                }
                                HStack(spacing: 8) {
                                    Text("\(t.partitions) partitions")
                                    Text("RF \(t.replicationFactor)")
                                    if t.underReplicated > 0 { Text("\(t.underReplicated) under-replicated").foregroundStyle(.red) }
                                }
                                .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions {
                            if !t.isInternal {
                                Button(role: .destructive) { toDelete = t } label: { Label("Delete", systemImage: "trash") }
                            }
                        }
                    }
                } header: {
                    HStack {
                        Text("\(list.count) topics")
                        Spacer()
                        Toggle("Internal", isOn: $showInternal).toggleStyle(.button).font(.caption2).controlSize(.mini)
                    }
                }
            }
            .overlay { if list.isEmpty { EmptyState(title: "No topics") } }
        }
        .searchable(text: $search, prompt: "Search topics")
        .navigationDestination(for: String.self) { TopicDetailView(name: $0) }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showCreate = true } label: { Image(systemName: "plus") }
            }
        }
        .refreshable { await reload() }
        .task { await loader.poll(every: 15) { try await session.api.kafkaTopics() } }
        .actionErrorAlert(runner)
        .sheet(isPresented: $showCreate) {
            CreateTopicSheet { name, partitions, rf in
                runner.run({ try await session.api.createTopic(name: name, partitions: partitions, replicationFactor: rf) }, then: reload)
            }
        }
        .confirmationDialog("Delete topic \(toDelete?.name ?? "")?",
                            isPresented: Binding(get: { toDelete != nil }, set: { if !$0 { toDelete = nil } }), titleVisibility: .visible) {
            if let t = toDelete {
                Button("Delete \(Format.number(t.messages)) messages", role: .destructive) {
                    runner.run({ try await session.api.deleteTopic(t.name) }, then: reload)
                }
            }
        } message: { Text("All messages in the topic are lost. Consumers of this topic will fail until it is recreated.") }
    }

    private func reload() async { await loader.load { try await session.api.kafkaTopics() } }
}

private struct CreateTopicSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onCreate: (String, Int, Int) -> Void
    @State private var name = ""
    @State private var partitions = 1
    @State private var replicationFactor = 1

    private var valid: Bool {
        let n = name.trimmingCharacters(in: .whitespaces)
        return !n.isEmpty && n.count <= 249 && n.allSatisfy { $0.isLetter || $0.isNumber || $0 == "." || $0 == "_" || $0 == "-" }
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Topic name", text: $name)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Stepper("Partitions: \(partitions)", value: $partitions, in: 1...1000)
                Stepper("Replication factor: \(replicationFactor)", value: $replicationFactor, in: 1...20)
                if !name.isEmpty && !valid {
                    Text("Only letters, numbers, '.', '_' and '-' are allowed.").font(.footnote).foregroundStyle(.red)
                }
            }
            .navigationTitle("New topic")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        onCreate(name.trimmingCharacters(in: .whitespaces), partitions, replicationFactor)
                        dismiss()
                    }
                    .disabled(!valid)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

struct TopicDetailView: View {
    @Environment(Session.self) private var session
    let name: String
    @State private var loader = Loader<KafkaTopicDetail>()
    @State private var messages = Loader<[KafkaMessage]>()
    @State private var showProduce = false
    @State private var produceKey = ""
    @State private var produceValue = ""
    @State private var runner = ActionRunner()

    var body: some View {
        Loaded(loader: loader, retry: reload) { t in
            List {
                Section {
                    KeyValue("Messages", Format.number(t.messages))
                    KeyValue("Partitions", String(t.partitions.count))
                }
                Section("Latest messages") {
                    if let msgs = messages.value {
                        if msgs.isEmpty { Text("No messages").foregroundStyle(.secondary) }
                        ForEach(msgs) { m in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack {
                                    Text("p\(m.partition) · \(m.offset)").font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                                    if let k = m.key { Badge(text: k, tone: .info) }
                                    Spacer()
                                    Text(Format.dateTime(m.timestamp)).font(.caption2).foregroundStyle(.secondary)
                                }
                                Text(m.value ?? "<null>")
                                    .font(.system(.caption, design: .monospaced))
                                    .lineLimit(6)
                                    .textSelection(.enabled)
                                if m.truncated { Text("truncated").font(.caption2).foregroundStyle(.orange) }
                            }
                        }
                    } else if let e = messages.error {
                        Text(e).foregroundStyle(.red).font(.footnote)
                    } else {
                        ProgressView()
                    }
                }
                Section("Partitions") {
                    ForEach(t.partitions) { p in
                        HStack {
                            Text("Partition \(p.partition)").font(.footnote.weight(.medium))
                            Spacer()
                            VStack(alignment: .trailing, spacing: 1) {
                                Text("leader \(p.leader) · isr \(p.isr.map(String.init).joined(separator: ","))")
                                Text("offsets \(p.low) – \(p.high)")
                            }
                            .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                        }
                    }
                }
                let custom = t.config.filter { !$0.isDefault }
                if !custom.isEmpty {
                    Section("Non-default config") {
                        ForEach(custom) { KeyValue($0.name, $0.value, mono: true) }
                    }
                }
            }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showProduce = true } label: { Image(systemName: "paperplane") }
            }
        }
        .refreshable { await reload() }
        .task { await reload() }
        .actionErrorAlert(runner)
        .sheet(isPresented: $showProduce) {
            NavigationStack {
                Form {
                    TextField("Key (optional)", text: $produceKey)
                    TextField("Value", text: $produceValue, axis: .vertical).lineLimit(4...12).font(.system(.body, design: .monospaced))
                }
                .navigationTitle("Produce to \(name)")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showProduce = false } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Send") {
                            let key = produceKey.isEmpty ? nil : produceKey
                            let value = produceValue
                            showProduce = false
                            produceValue = ""
                            runner.run({ try await session.api.produce(name, key: key, value: value) }, then: reload)
                        }
                        .disabled(produceValue.isEmpty)
                    }
                }
            }
        }
    }

    private func reload() async {
        async let a: () = loader.load { try await session.api.kafkaTopic(name) }
        async let b: () = messages.load { try await session.api.kafkaMessages(name, limit: 20) }
        _ = await (a, b)
    }
}

private struct GroupsList: View {
    @Environment(Session.self) private var session
    @State private var loader = Loader<[KafkaGroup]>()
    @State private var runner = ActionRunner()
    @State private var toDelete: KafkaGroup?

    var body: some View {
        Loaded(loader: loader, retry: reload) { groups in
            List(groups) { g in
                NavigationLink { GroupDetailView(id: g.groupId) } label: {
                    HStack {
                        StatusDot(tone: g.state == "Stable" ? .ok : g.state == "Empty" || g.state == "Dead" ? .muted : .warning)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(g.groupId).font(.body.weight(.medium)).lineLimit(1)
                            Text("\(g.state) · \(g.members) members · \(g.protocol)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .swipeActions {
                    if g.members == 0 {
                        Button(role: .destructive) { toDelete = g } label: { Label("Delete", systemImage: "trash") }
                    }
                }
            }
            .overlay { if groups.isEmpty { EmptyState(title: "No consumer groups") } }
        }
        .refreshable { await reload() }
        .task { await loader.poll(every: 15) { try await session.api.kafkaGroups() } }
        .actionErrorAlert(runner)
        .confirmationDialog("Delete group \(toDelete?.groupId ?? "")?",
                            isPresented: Binding(get: { toDelete != nil }, set: { if !$0 { toDelete = nil } }), titleVisibility: .visible) {
            if let g = toDelete {
                Button("Delete", role: .destructive) { runner.run({ try await session.api.deleteGroup(g.groupId) }, then: reload) }
            }
        } message: { Text("Committed offsets are discarded. A consumer that rejoins with this group id starts from its configured reset position.") }
    }

    private func reload() async { await loader.load { try await session.api.kafkaGroups() } }
}

private struct GroupDetailView: View {
    @Environment(Session.self) private var session
    let id: String
    @State private var loader = Loader<KafkaGroupDetail>()

    var body: some View {
        Loaded(loader: loader, retry: reload) { g in
            List {
                Section {
                    KeyValue("State", g.state)
                    KeyValue("Protocol", g.protocol)
                    KeyValue("Total lag", Format.number(g.totalLag))
                }
                Section("Members") {
                    if g.members.isEmpty { Text("No active members").foregroundStyle(.secondary) }
                    ForEach(g.members) { m in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(m.clientId).font(.footnote.weight(.medium))
                            Text("\(m.host) · \(m.memberId)").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                    }
                }
                Section("Offsets") {
                    ForEach(g.offsets) { o in
                        HStack {
                            Text("\(o.topic) / p\(o.partition)").font(.footnote).lineLimit(1)
                            Spacer()
                            VStack(alignment: .trailing, spacing: 1) {
                                Text("lag \(o.lag.map { Format.number($0) } ?? "–")").foregroundStyle((o.lag ?? 0) > 0 ? .orange : .secondary)
                                Text("\(o.committed ?? "–") / \(o.end ?? "–")").foregroundStyle(.secondary)
                            }
                            .font(.caption2.monospacedDigit())
                        }
                    }
                }
            }
        }
        .navigationTitle(id)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await reload() }
        .task { await loader.poll(every: 10) { try await session.api.kafkaGroup(id) } }
    }

    private func reload() async { await loader.load { try await session.api.kafkaGroup(id) } }
}
