import Foundation
import Observation

@MainActor
@Observable
final class Session {
    static let defaultServer = "https://panel.helloworlds.co.in"
    private static let serverKey = "vps_panel_server"
    private static let userKey = "vps_panel_user"
    private static let tokenKey = "vps_panel_token"
    private static let methodKey = "vps_panel_method"
    private static let nameKey = "vps_panel_name"
    private static let roleKey = "vps_panel_role"
    private static let providerKey = "vps_panel_provider"
    /// The app's own URL scheme, where the server hands the session back after a TMS sign-in.
    static let callbackScheme = "vpspanel"

    enum Method: String { case tms, panel }

    private(set) var serverURL: String
    private(set) var username: String?
    /// The person's full name (TMS sign-ins) and panel role (owner / admin / viewer).
    private(set) var displayName: String?
    private(set) var role: String?
    /// How the single sign-on is named by the server ("HW"); shown as "<name> account".
    private(set) var providerName: String
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
        // UI tests of the sign-in screen start from a signed-out state whatever an earlier run left behind
        if ProcessInfo.processInfo.arguments.contains("-vps_panel_signed_out") {
            token = nil
            Keychain.write(Self.tokenKey, nil)
        }
#endif
        serverURL = server
        username = UserDefaults.standard.string(forKey: Self.userKey)
        displayName = UserDefaults.standard.string(forKey: Self.nameKey)
        role = UserDefaults.standard.string(forKey: Self.roleKey)
        providerName = UserDefaults.standard.string(forKey: Self.providerKey) ?? "HW"
        isAuthenticated = token != nil
        method = Method(rawValue: UserDefaults.standard.string(forKey: Self.methodKey) ?? "") ?? .panel
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

    /// Which sign-in the server offers, used to pick the default on the login screen.
    func authMode(server: String) async -> AuthMode? {
        guard let url = Self.normalize(server: server) else { return nil }
        let probe = APIClient(baseURL: url, token: nil)
        return try? await probe.authMode()
    }

    /// The panel's own admin password.
    func login(server: String, username: String, password: String) async throws {
        guard let url = Self.normalize(server: server) else { throw Self.badServer }
        api.baseURL = url
        api.token = nil
        let response = try await api.login(username: username, password: password)
        await finishSignIn(server: url, token: response.token, method: .panel)
    }

    /// Where to send the browser for Sign in with TMS; the browser session comes back through `completeTmsLogin`.
    func tmsLoginURL(server: String, providerName name: String) throws -> URL {
        guard let url = Self.normalize(server: server) else { throw Self.badServer }
        providerName = name
        UserDefaults.standard.set(name, forKey: Self.providerKey)
        api.baseURL = url
        return api.tmsLoginURL()
    }

    /// The vpspanel://signed-in?token=… (or ?error=…) URL the server handed back after the TMS sign-in.
    func completeTmsLogin(server: String, callback: URL) async throws {
        guard let url = Self.normalize(server: server) else { throw Self.badServer }
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if let message = items.first(where: { $0.name == "error" })?.value {
            throw APIError(status: 401, message: message, code: "NO_ACCESS")
        }
        guard let token = items.first(where: { $0.name == "token" })?.value, !token.isEmpty else {
            throw APIError(status: 0, message: "The sign-in did not return a session", code: nil)
        }
        api.baseURL = url
        await finishSignIn(server: url, token: token, method: .tms)
    }

    private static let badServer = APIError(status: 0, message: "Enter a valid server address, e.g. https://panel.example.com", code: nil)

    private func finishSignIn(server url: URL, token: String, method: Method) async {
        api.token = token
        Keychain.write(Self.tokenKey, token)
        let me = try? await api.me()
        let name = me?.username ?? username ?? ""
        UserDefaults.standard.set(url.absoluteString, forKey: Self.serverKey)
        UserDefaults.standard.set(name, forKey: Self.userKey)
        UserDefaults.standard.set(me?.name, forKey: Self.nameKey)
        UserDefaults.standard.set(me?.role, forKey: Self.roleKey)
        UserDefaults.standard.set(method.rawValue, forKey: Self.methodKey)
        serverURL = url.absoluteString
        username = name
        displayName = me?.name
        role = me?.role
        self.method = method
        isAuthenticated = true
        capabilities = nil
        await loadCapabilities()
    }

    func logout() {
        let client = api
        Task { _ = try? await client.logout() }
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
