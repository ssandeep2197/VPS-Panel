import SwiftUI

struct RootView: View {
    @Environment(Session.self) private var session
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        if session.isAuthenticated {
            MainTabs()
                .task(id: session.isAuthenticated) { await session.loadCapabilities() }
                .onChange(of: scenePhase) { _, phase in
                    // Pick up server-side changes (e.g. Kafka newly configured) without a relaunch.
                    if phase == .active { Task { await session.loadCapabilities() } }
                }
        } else {
            LoginView()
        }
    }
}

private struct MainTabs: View {
    @Environment(Session.self) private var session

    var body: some View {
        let caps = session.capabilities
        TabView {
            DashboardView()
                .tabItem { Label("Dashboard", systemImage: "gauge.with.dots.needle.33percent") }
            DockerView()
                .tabItem { Label("Docker", systemImage: "shippingbox") }
            if caps?.kubernetes ?? true {
                KubernetesView()
                    .tabItem { Label("Kubernetes", systemImage: "circle.hexagongrid") }
            }
            if caps?.kafka ?? true {
                NavigationStack { KafkaView() }
                    .tabItem { Label("Kafka", systemImage: "arrow.triangle.branch") }
            } else if caps?.systemd ?? true {
                ServicesView()
                    .tabItem { Label("Services", systemImage: "gearshape.2") }
            }
            MoreView()
                .tabItem { Label("More", systemImage: "ellipsis.circle") }
        }
        // Rebuild the tab bar when the server's feature set changes; SwiftUI does not reliably
        // insert or remove conditional tabs in a live TabView otherwise.
        .id(tabsKey(caps))
    }

    private func tabsKey(_ caps: Capabilities?) -> String {
        guard let caps else { return "loading" }
        return "\(caps.systemd)-\(caps.kubernetes)-\(caps.kafka)"
    }
}

private struct MoreView: View {
    @Environment(Session.self) private var session

    var body: some View {
        let caps = session.capabilities
        NavigationStack {
            List {
                Section {
                    NavigationLink { SitesView() } label: { Label("Sites", systemImage: "globe") }
                    if (caps?.systemd ?? true) && (caps?.kafka ?? true) {
                        NavigationLink { ServicesView(embedded: true) } label: { Label("Services", systemImage: "gearshape.2") }
                    }
                    if caps?.kafka == false {
                        NavigationLink { KafkaView() } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Kafka")
                                    Text("Server reports it is not configured").font(.caption).foregroundStyle(.secondary)
                                }
                            } icon: { Image(systemName: "arrow.triangle.branch") }
                        }
                    }
                    NavigationLink { ProcessesView() } label: { Label("Processes", systemImage: "cpu") }
                    if caps?.kubernetes ?? true {
                        NavigationLink { RequestsView() } label: { Label("Requests", systemImage: "network") }
                    }
                    NavigationLink { ActivityView() } label: { Label("Activity", systemImage: "list.bullet.clipboard") }
                }
                Section {
                    NavigationLink { SettingsView() } label: { Label("Settings", systemImage: "gear") }
                }
            }
            .navigationTitle("More")
            .refreshable { await session.loadCapabilities() }
            .task { await session.loadCapabilities() }
        }
    }
}

struct SettingsView: View {
    @Environment(Session.self) private var session
    @State private var confirmLogout = false

    var body: some View {
        List {
            Section("Connection") {
                KeyValue("Server", session.serverURL, mono: true)
                KeyValue("User", session.username)
                if let caps = session.capabilities {
                    KeyValue("Platform", caps.platform)
                    KeyValue("systemd", caps.systemd ? "available" : "not available")
                    KeyValue("Docker", "available")
                    KeyValue("Kubernetes", caps.kubernetes ? "available" : "not available")
                    KeyValue("Kafka", caps.kafka ? "configured" : "not configured")
                }
                Button("Re-check server features") { Task { await session.loadCapabilities() } }
            }
            Section {
                Button("Sign out", role: .destructive) { confirmLogout = true }
            } footer: {
                Text("Sessions expire after 12 hours on the server.")
            }
        }
        .navigationTitle("Settings")
        .confirmationDialog("Sign out of \(session.serverURL)?", isPresented: $confirmLogout, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { session.logout() }
        }
    }
}
