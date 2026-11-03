import Charts
import SwiftUI

struct DashboardView: View {
    @Environment(Session.self) private var session
    @State private var overview = Loader<Overview>()
    @State private var sites = Loader<SitesReport>()
    @State private var samples: [MetricSample] = []
    @State private var stream: StreamClient?

    private var latest: MetricSample? { samples.last }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    hostCard
                    sitesCard
                    liveTiles
                    charts
                    disks
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Dashboard")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if let stream { StreamStatusLabel(status: stream.status, error: stream.error) }
                }
            }
            .refreshable { await overview.load { try await session.api.overview() } }
            .task { await overview.poll(every: 60) { try await session.api.overview() } }
            .task { await sites.poll(every: 30) { try await session.api.sites() } }
            .onAppear(perform: startStream)
            .onDisappear { stream?.stop(); stream = nil }
        }
    }

    private func startStream() {
        guard stream == nil else { return }
        let api = session.api
        let client = StreamClient(api: api, request: ["channel": "metrics"]) {
            // reset on reconnect; the server resends history
        } onMessage: { data in
            guard let msg = try? JSONDecoder().decode(MetricsMessage.self, from: data) else { return }
            if msg.type == "history", let history = msg.samples {
                samples = history
            } else if msg.type == "sample", let s = msg.sample {
                samples.append(s)
                if samples.count > 360 { samples.removeFirst(samples.count - 360) }
            }
        }
        stream = client
        client.start()
    }

    private struct MetricsMessage: Decodable {
        let type: String
        let samples: [MetricSample]?
        let sample: MetricSample?
    }

    // MARK: - Sections

    @ViewBuilder private var hostCard: some View {
        if let o = overview.value {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Image(systemName: "server.rack").foregroundStyle(.tint)
                    Text(o.hostname).font(.headline)
                    Spacer()
                    Text("up \(Format.duration(o.uptime))").font(.caption).foregroundStyle(.secondary)
                }
                Text("\(o.distro) · \(o.kernel) · \(o.arch)").font(.caption).foregroundStyle(.secondary)
                Text("\(o.cpuModel) · \(o.cpuCores) cores").font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        } else if let error = overview.error {
            Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).font(.footnote)
        } else {
            ProgressView().frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder private var sitesCard: some View {
        if let r = sites.value {
            let down = r.sites.filter { $0.status == "down" }
            let warn = r.sites.filter { $0.status == "degraded" }
            NavigationLink { SitesView() } label: {
                HStack(spacing: 12) {
                    Image(systemName: "globe").foregroundStyle(.tint)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(r.sites.count - down.count) of \(r.sites.count) sites working").font(.subheadline.weight(.semibold))
                        if !down.isEmpty {
                            Text(down.map(\.host).joined(separator: ", ")).font(.caption).foregroundStyle(.red).lineLimit(2)
                        } else if !warn.isEmpty {
                            Text("\(warn.count) with warnings").font(.caption).foregroundStyle(.orange)
                        } else {
                            Text("All sites up").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    StatusDot(tone: down.isEmpty ? (warn.isEmpty ? .ok : .warning) : .critical)
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                }
                .padding(12)
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
        }
    }

    private var liveTiles: some View {
        let s = latest
        let memFrac = s.map { $0.memTotal > 0 ? $0.memUsed / $0.memTotal : 0 } ?? 0
        let swapFrac = s.map { $0.swapTotal > 0 ? $0.swapUsed / $0.swapTotal : 0 } ?? 0
        return LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
            StatTile(label: "CPU", value: s.map { Format.percent($0.cpu) } ?? "–",
                     detail: s.map { "load \($0.load.map { String(format: "%.2f", $0) }.joined(separator: " / "))" },
                     tone: (s?.cpu ?? 0) > 90 ? .critical : nil)
            StatTile(label: "Memory", value: Format.percent(memFrac * 100),
                     detail: s.map { "\(Format.bytes($0.memUsed)) of \(Format.bytes($0.memTotal))" },
                     tone: memFrac > 0.9 ? .critical : nil)
            StatTile(label: "Swap", value: (s?.swapTotal ?? 0) > 0 ? Format.percent(swapFrac * 100) : "none",
                     detail: s.map { $0.swapTotal > 0 ? "\(Format.bytes($0.swapUsed)) of \(Format.bytes($0.swapTotal))" : "no swap configured" })
            StatTile(label: "Network", value: s.map { "↓ \(Format.rate($0.rxSec))" } ?? "–",
                     detail: s.map { "↑ \(Format.rate($0.txSec))" })
        }
    }

    @ViewBuilder private var charts: some View {
        if samples.count > 1 {
            chartCard(title: "CPU %") {
                Chart(samples) { s in
                    AreaMark(x: .value("Time", s.date), y: .value("CPU", s.cpu))
                        .foregroundStyle(.linearGradient(colors: [.blue.opacity(0.35), .blue.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                    LineMark(x: .value("Time", s.date), y: .value("CPU", s.cpu)).foregroundStyle(.blue)
                }
                .chartYScale(domain: 0...100)
            }
            chartCard(title: "Memory") {
                Chart(samples) { s in
                    LineMark(x: .value("Time", s.date), y: .value("Used", s.memUsed / 1_073_741_824))
                        .foregroundStyle(.purple)
                }
                .chartYAxisLabel("GB")
                .chartYScale(domain: 0...max(1, (latest?.memTotal ?? 0) / 1_073_741_824))
            }
            chartCard(title: "Network") {
                Chart(samples) { s in
                    LineMark(x: .value("Time", s.date), y: .value("Rate", s.rxSec / 1024), series: .value("Dir", "Down"))
                        .foregroundStyle(.green)
                    LineMark(x: .value("Time", s.date), y: .value("Rate", s.txSec / 1024), series: .value("Dir", "Up"))
                        .foregroundStyle(.orange)
                }
                .chartYAxisLabel("KB/s")
                .chartForegroundStyleScale(["Down": .green, "Up": .orange])
            }
        }
    }

    private func chartCard<C: View>(title: String, @ViewBuilder chart: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.subheadline.weight(.semibold))
            chart()
                .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) { _ in AxisGridLine(); AxisValueLabel(format: .dateTime.hour().minute()) } }
                .frame(height: 140)
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder private var disks: some View {
        if let disks = overview.value?.disks, !disks.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("Disks").font(.subheadline.weight(.semibold))
                ForEach(disks) { d in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(d.mount).font(.footnote.weight(.medium))
                            Text(d.type).font(.caption2).foregroundStyle(.secondary)
                            Spacer()
                            Text("\(Format.bytes(d.used)) / \(Format.bytes(d.size))").font(.caption).foregroundStyle(.secondary)
                        }
                        UsageBar(fraction: d.usePercent / 100)
                    }
                }
            }
            .padding(12)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        }
    }
}
