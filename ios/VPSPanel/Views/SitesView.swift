import SwiftUI

/// Health of every hostname the server fronts, checked from the server itself.
struct SitesView: View {
    @Environment(Session.self) private var session
    @State private var loader = Loader<SitesReport>()
    @State private var runner = ActionRunner()
    @State private var search = ""
    @State private var problemsOnly = false

    var body: some View {
        Loaded(loader: loader, retry: reload) { report in
            let list = report.sites.filter { s in
                (!problemsOnly || s.status != "ok") &&
                (search.isEmpty || s.host.localizedCaseInsensitiveContains(search) || s.name.localizedCaseInsensitiveContains(search))
            }
            List {
                Section {
                    HStack {
                        StatTile(label: "Sites", value: "\(report.sites.count)")
                        StatTile(label: "Working", value: "\(report.sites.filter { $0.status == "ok" }.count)", tone: .ok)
                        StatTile(label: "Warnings", value: "\(report.sites.filter { $0.status == "degraded" }.count)",
                                 tone: report.sites.contains { $0.status == "degraded" } ? .warning : nil)
                        StatTile(label: "Down", value: "\(report.sites.filter { $0.status == "down" }.count)",
                                 tone: report.sites.contains { $0.status == "down" } ? .critical : nil)
                    }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
                if let d = report.discovery {
                    Section { Label(d, systemImage: "info.circle").font(.footnote).foregroundStyle(.secondary) }
                }
                Section {
                    ForEach(list) { site in
                        NavigationLink(value: site) { SiteRow(site: site) }
                    }
                } header: {
                    HStack {
                        if let at = report.checkedAt { Text("Checked \(Format.ago(at))") }
                        Spacer()
                        Toggle("Problems only", isOn: $problemsOnly).toggleStyle(.button).font(.caption2).controlSize(.mini)
                    }
                }
            }
            .overlay { if list.isEmpty { EmptyState(title: report.sites.isEmpty ? "No sites found" : "No sites match", systemImage: "globe") } }
        }
        .searchable(text: $search, prompt: "Search sites")
        .navigationTitle("Sites")
        .navigationDestination(for: SiteCheck.self) { SiteDetailView(site: $0) }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    runner.run({ _ = try await session.api.refreshSites() }, then: reload)
                } label: {
                    if runner.busy { ProgressView() } else { Image(systemName: "arrow.clockwise") }
                }
                .disabled(runner.busy)
            }
        }
        .refreshable { await reload() }
        .task { await loader.poll(every: 30) { try await session.api.sites() } }
        .actionErrorAlert(runner)
    }

    private func reload() async { await loader.load { try await session.api.sites() } }
}

func siteTone(_ status: String) -> Tone {
    switch status {
    case "ok": .ok
    case "degraded": .warning
    case "down": .critical
    default: .muted
    }
}

func siteStatusText(_ status: String) -> String {
    switch status {
    case "ok": "Working"
    case "degraded": "Warnings"
    case "down": "Not working"
    default: "Unknown"
    }
}

private struct SiteRow: View {
    @Environment(Session.self) private var session
    let site: SiteCheck

    var body: some View {
        HStack(spacing: 12) {
            SiteThumbnail(site: site, width: 96, height: 60)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    StatusDot(tone: siteTone(site.status))
                    Text(site.name).font(.body.weight(.medium)).lineLimit(1)
                }
                Text(site.host).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                Text(site.problems.first ?? summary).font(.caption2)
                    .foregroundStyle(site.problems.isEmpty ? Color.secondary : Color.red)
                    .lineLimit(2)
            }
        }
    }

    private var summary: String {
        var parts: [String] = []
        if let s = site.http.status {
            let ms = site.http.latencyMs.map { $0 >= 1000 ? String(format: "%.1fs", $0 / 1000) : "\(Int($0))ms" } ?? ""
            parts.append("HTTP \(s) \(ms)")
        }
        if let d = site.tls.daysLeft { parts.append("cert \(d)d") }
        if let b = site.backends.first {
            parts.append(b.kind == "pods" ? "\(b.ready)/\(b.total) pods" : (b.container.map { "\($0.name) \($0.state)" } ?? b.addresses.joined(separator: ",")))
        }
        return parts.joined(separator: " · ")
    }
}

/// Screenshot loaded through the API with the bearer token; falls back to the site's initial.
struct SiteThumbnail: View {
    @Environment(Session.self) private var session
    let site: SiteCheck
    var width: CGFloat = 96
    var height: CGFloat = 60
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8).fill(Color(.tertiarySystemFill))
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Text(site.name.prefix(1).uppercased()).font(.system(size: height * 0.45, weight: .semibold)).foregroundStyle(.tertiary)
            }
        }
        .frame(width: width, height: height)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .task(id: site.thumbnailAt) {
            guard site.thumbnailAt != nil else { image = nil; return }
            if let data = try? await session.api.bytes("/sites/\(enc(site.host))/thumbnail"), let img = UIImage(data: data) {
                image = img
            }
        }
    }
}

struct SiteDetailView: View {
    @Environment(Session.self) private var session
    @Environment(\.openURL) private var openURL
    let site: SiteCheck
    @State private var runner = ActionRunner()

    var body: some View {
        List {
            Section {
                SiteThumbnail(site: site, width: UIScreen.main.bounds.width - 64, height: (UIScreen.main.bounds.width - 64) * 0.625)
                    .frame(maxWidth: .infinity)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowBackground(Color.clear)
                HStack {
                    StatusDot(tone: siteTone(site.status))
                    Text(siteStatusText(site.status))
                    Spacer()
                    Button { openURL(URL(string: site.url)!) } label: { Label("Open", systemImage: "safari") }
                        .buttonStyle(.bordered).controlSize(.small)
                }
            }
            if !site.problems.isEmpty {
                Section("Why it is not working") {
                    ForEach(site.problems, id: \.self) { p in
                        Label { Text(p).font(.footnote) } icon: { Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red) }
                    }
                }
            }
            if !site.notes.isEmpty {
                Section("Notes") {
                    ForEach(site.notes, id: \.self) { Text($0).font(.footnote).foregroundStyle(.secondary) }
                }
            }
            Section("Response") {
                KeyValue("Status", site.http.status.map { "HTTP \($0)" } ?? (site.http.error ?? "no response"))
                KeyValue("Time", site.http.latencyMs.map { Format.ms($0) })
                KeyValue("Title", site.http.title)
                KeyValue("Final URL", site.http.finalUrl, mono: true)
                KeyValue("Server", site.http.server)
            }
            Section("Certificate") {
                KeyValue("Issuer", site.tls.placeholder ? "ingress placeholder" : site.tls.issuer)
                KeyValue("Trusted", site.tls.valid ? "yes" : (site.tls.error ?? "no"))
                KeyValue("Expires", site.tls.expires.map { Format.dateTime($0) })
                KeyValue("Days left", site.tls.daysLeft.map(String.init))
                if let c = site.certificate {
                    KeyValue("cert-manager", c.ready ? "ready" : (c.message.isEmpty ? "not ready" : c.message))
                }
            }
            Section("Routing") {
                KeyValue("DNS", site.dns.addresses.isEmpty ? "no record" : site.dns.addresses.joined(separator: ", "), mono: true)
                KeyValue("Points here", site.dns.pointsHere.map { $0 ? "yes" : "no" })
                KeyValue("Namespace", site.namespace)
                KeyValue("Ingress", site.ingress)
            }
            ForEach(site.backends) { b in
                Section("Backend · \(b.service)") {
                    switch b.kind {
                    case "pods":
                        KeyValue("Pods ready", "\(b.ready) of \(b.total)")
                        ForEach(b.pods) { p in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    StatusDot(tone: podTone(status: p.status))
                                    Text(p.name).font(.footnote).lineLimit(1)
                                    Spacer()
                                    Text(p.status).font(.caption).foregroundStyle(.secondary)
                                }
                                Text(p.image).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    case "external":
                        KeyValue("Address", b.addresses.joined(separator: ", "), mono: true)
                        KeyValue("Reachable", b.reachable.map { $0 ? "yes" : "no" })
                        if let c = b.container {
                            KeyValue("Container", "\(c.name) · \(c.state)")
                            KeyValue("Image", c.image, mono: true)
                            KeyValue("Uptime", c.status)
                        }
                    default:
                        Text("Service has no endpoints").foregroundStyle(.red).font(.footnote)
                    }
                }
            }
            Section {
                Button {
                    runner.run({ try await session.api.captureSiteThumbnail(site.host) })
                } label: { Label("Take a new screenshot", systemImage: "camera") }
                .disabled(runner.busy)
            } footer: {
                Text("Checked \(Format.ago(site.checkedAt)). Screenshot \(site.thumbnailAt.map { Format.ago($0) } ?? "not taken yet").")
            }
        }
        .navigationTitle(site.name)
        .navigationBarTitleDisplayMode(.inline)
        .actionErrorAlert(runner)
    }
}
