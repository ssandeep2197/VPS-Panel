import Foundation
import Observation

@MainActor
@Observable
final class Session {
    static let defaultServer = "https://panel.helloworlds.co.in"
    private static let serverKey = "vps_panel_server"
    private static let userKey = "vps_panel_user"
    private static let tokenKey = "vps_panel_token"
    private static let cookieKey = "vps_panel_sso"
    private static let methodKey = "vps_panel_method"

    enum Method: String { case tms, panel }

    private(set) var serverURL: String
    private(set) var username: String?
    private(set) var isAuthenticated: Bool
    /// How the current session was obtained (TMS account or the panel's own password).
    private(set) var method: Method
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
        let cookie = Keychain.read(Self.cookieKey)
        serverURL = server
        username = UserDefaults.standard.string(forKey: Self.userKey)
        isAuthenticated = token != nil || cookie != nil
        method = Method(rawValue: UserDefaults.standard.string(forKey: Self.methodKey) ?? "") ?? (cookie != nil ? .tms : .panel)
        api = APIClient(baseURL: URL(string: server) ?? URL(string: Self.defaultServer)!, token: token, cookie: cookie)
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

    /// Which sign-in the server offers, used to pick the default on the login screen.
    func authMode(server: String) async -> AuthMode? {
        guard let url = Self.normalize(server: server) else { return nil }
        let probe = APIClient(baseURL: url, token: nil)
        return try? await probe.authMode()
    }

    func login(server: String, username: String, password: String, method: Method) async throws {
        guard let url = Self.normalize(server: server) else {
            throw APIError(status: 0, message: "Enter a valid server address, e.g. https://panel.example.com", code: nil)
        }
        api.baseURL = url
        api.token = nil
        api.cookie = nil
        let name: String
        switch method {
        case .tms:
            let response = try await api.tmsLogin(email: username, password: password)
            api.cookie = response.cookie
            Keychain.write(Self.cookieKey, response.cookie)
            Keychain.write(Self.tokenKey, nil)
            name = response.username
        case .panel:
            let response = try await api.login(username: username, password: password)
            api.token = response.token
            Keychain.write(Self.tokenKey, response.token)
            Keychain.write(Self.cookieKey, nil)
            name = response.username
        }
        UserDefaults.standard.set(url.absoluteString, forKey: Self.serverKey)
        UserDefaults.standard.set(name, forKey: Self.userKey)
        UserDefaults.standard.set(method.rawValue, forKey: Self.methodKey)
        serverURL = url.absoluteString
        self.username = name
        self.method = method
        isAuthenticated = true
        capabilities = nil
        await loadCapabilities()
    }

    func logout() {
        let client = api
        Task { try? await client.logout() }
        api.token = nil
        api.cookie = nil
        Keychain.write(Self.tokenKey, nil)
        Keychain.write(Self.cookieKey, nil)
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
