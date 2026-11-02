import SwiftUI

struct ProcessesView: View {
    @Environment(Session.self) private var session
    @State private var tab = Tab.processes
    @State private var processes = Loader<ProcessList>()
    @State private var ports = Loader<[PortRow]>()
    @State private var sort = Sort.cpu
    @State private var search = ""
    @State private var runner = ActionRunner()
    @State private var killTarget: ProcessRow?

    enum Tab: String, CaseIterable { case processes = "Processes", ports = "Ports" }
    enum Sort: String, CaseIterable { case cpu = "CPU", mem = "Memory", name = "Name" }

    var body: some View {
        VStack(spacing: 0) {
            Picker("Section", selection: $tab) {
                ForEach(Tab.allCases, id: \.self) { Text($0.rawValue) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.bottom, 8)
            switch tab {
            case .processes: processList
            case .ports: portList
            }
        }
        .navigationTitle("Processes")
        .searchable(text: $search, prompt: tab == .processes ? "Search processes" : "Search ports")
        .toolbar {
            if tab == .processes {
                ToolbarItem(placement: .topBarTrailing) {
                    Picker("Sort", selection: $sort) { ForEach(Sort.allCases, id: \.self) { Text($0.rawValue) } }
                        .pickerStyle(.menu)
                }
            }
        }
        .actionErrorAlert(runner)
        .confirmationDialog("Signal \(killTarget?.name ?? "") (PID \(killTarget?.pid ?? 0))?",
                            isPresented: Binding(get: { killTarget != nil }, set: { if !$0 { killTarget = nil } }), titleVisibility: .visible) {
            if let p = killTarget {
                Button("SIGTERM (graceful)") { signal(p, "SIGTERM") }
                Button("SIGHUP (reload)") { signal(p, "SIGHUP") }
                Button("SIGKILL (force)", role: .destructive) { signal(p, "SIGKILL") }
            }
        }
    }

    private func signal(_ p: ProcessRow, _ sig: String) {
        runner.run({ try await session.api.killProcess(p.pid, signal: sig) }, then: { await processes.load { try await session.api.processes() } })
    }

    private var processList: some View {
        Loaded(loader: processes, retry: { await processes.load { try await session.api.processes() } }) { pl in
            let list = pl.list
                .filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) || $0.command.localizedCaseInsensitiveContains(search) || String($0.pid) == search }
                .sorted {
                    switch sort {
                    case .cpu: $0.cpu > $1.cpu
                    case .mem: $0.memRss > $1.memRss
                    case .name: $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
                    }
                }
            List {
                Section {
                    ForEach(list) { p in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(p.name).font(.body.weight(.medium)).lineLimit(1)
                                Spacer()
                                Text(Format.percent(p.cpu)).font(.caption.monospacedDigit()).frame(width: 52, alignment: .trailing)
                                Text(Format.bytes(p.memRss)).font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 64, alignment: .trailing)
                            }
                            Text("\(p.pid) · \(p.user) · \(p.state)").font(.caption2).foregroundStyle(.secondary)
                            Text(p.command).font(.system(.caption2, design: .monospaced)).foregroundStyle(.tertiary).lineLimit(1)
                        }
                        .swipeActions {
                            if p.pid > 1 { Button(role: .destructive) { killTarget = p } label: { Label("Signal", systemImage: "bolt") } }
                        }
                    }
                } header: {
                    Text("\(pl.total) processes · \(pl.running) running · \(pl.sleeping) sleeping")
                }
            }
            .overlay { if list.isEmpty { EmptyState(title: "No processes match") } }
        }
        .refreshable { await processes.load { try await session.api.processes() } }
        .task { await processes.poll(every: 5) { try await session.api.processes() } }
    }

    private var portList: some View {
        Loaded(loader: ports, retry: { await ports.load { try await session.api.ports() } }) { rows in
            let list = rows.filter { search.isEmpty || $0.process.localizedCaseInsensitiveContains(search) || String($0.port).contains(search) }
                .sorted { $0.port < $1.port }
            List(list) { r in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(r.port)").font(.body.weight(.semibold).monospacedDigit())
                        Text("\(r.proto) \(r.address)").font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(r.process.isEmpty ? "–" : r.process).font(.footnote)
                        if let pid = r.pid { Text("PID \(pid)").font(.caption2).foregroundStyle(.secondary) }
                    }
                }
            }
            .overlay { if list.isEmpty { EmptyState(title: "No listening ports") } }
        }
        .refreshable { await ports.load { try await session.api.ports() } }
        .task { await ports.poll(every: 15) { try await session.api.ports() } }
    }
}
