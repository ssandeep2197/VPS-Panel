import Foundation
import Observation

@MainActor
@Observable
final class Session {
    static let defaultServer = "https://panel.helloworlds.co.in"
    private static let serverKey = "vps_panel_server"
    private static let userKey = "vps_panel_user"
    private static let tokenKey = "vps_panel_token"

    private(set) var serverURL: String
    private(set) var username: String?
    private(set) var isAuthenticated: Bool
    var capabilities: Capabilities?
    let api: APIClient

    init() {
        let server = UserDefaults.standard.string(forKey: Self.serverKey) ?? Self.defaultServer
        var token = Keychain.read(Self.tokenKey)
#if DEBUG
        // Lets the simulator start signed in: SIMCTL_CHILD_VPS_PANEL_TOKEN=<jwt> xcrun simctl launch ...
        if let injected = ProcessInfo.processInfo.environment["VPS_PANEL_TOKEN"], !injected.isEmpty {
            token = injected
        }
#endif
        serverURL = server
        username = UserDefaults.standard.string(forKey: Self.userKey)
        isAuthenticated = token != nil
        api = APIClient(baseURL: URL(string: server) ?? URL(string: Self.defaultServer)!, token: token)
        api.onUnauthenticated = { [weak self] in
            Task { @MainActor in self?.logout() }
        }
    }

    static func normalize(server: String) -> URL? {
        var text = server.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return nil }
        if !text.contains("://") { text = "https://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), let scheme = url.scheme, ["http", "https"].contains(scheme), url.host != nil else { return nil }
        return url
    }

    func login(server: String, username: String, password: String) async throws {
        guard let url = Self.normalize(server: server) else {
            throw APIError(status: 0, message: "Enter a valid server address, e.g. https://panel.example.com", code: nil)
        }
        api.baseURL = url
        api.token = nil
        let response = try await api.login(username: username, password: password)
        api.token = response.token
        Keychain.write(Self.tokenKey, response.token)
        UserDefaults.standard.set(url.absoluteString, forKey: Self.serverKey)
        UserDefaults.standard.set(response.username, forKey: Self.userKey)
        serverURL = url.absoluteString
        self.username = response.username
        isAuthenticated = true
        capabilities = nil
        await loadCapabilities()
    }

    func logout() {
        api.token = nil
        Keychain.write(Self.tokenKey, nil)
        isAuthenticated = false
        capabilities = nil
    }

    func loadCapabilities() async {
        guard isAuthenticated else { return }
        do { capabilities = try await api.capabilities() } catch {
            // Capabilities fall back to "everything visible"; each page shows its own error if needed.
            if capabilities == nil { capabilities = Capabilities(systemd: true, kafka: true, kubernetes: true, platform: "unknown") }
        }
    }
}
