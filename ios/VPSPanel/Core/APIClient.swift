import Foundation

struct APIError: LocalizedError {
    let status: Int
    let message: String
    let code: String?
    var errorDescription: String? { message }
}

/// Percent-encodes a path segment the same way `encodeURIComponent` does.
func enc(_ value: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-_.!~*'()")
    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
}

final class APIClient: @unchecked Sendable {
    var baseURL: URL
    /** The panel session token: from the admin password login, or handed back by the server after a TMS sign-in. */
    var token: String?
    var onUnauthenticated: (@Sendable () -> Void)?

    /// Cookies are never used by the app: every request carries the bearer token.
    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.waitsForConnectivity = false
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        return URLSession(configuration: config)
    }

    private let session = APIClient.makeSession()

    init(baseURL: URL, token: String?) {
        self.baseURL = baseURL
        self.token = token
    }

    func authorize(_ req: inout URLRequest) {
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
    }

    /// The page that starts Sign in with TMS; it ends by opening vpspanel://signed-in?token=… in the app.
    func tmsLoginURL() -> URL {
        let base = baseURL.absoluteString.hasSuffix("/") ? String(baseURL.absoluteString.dropLast()) : baseURL.absoluteString
        return URL(string: base + "/auth/login?client=ios")!
    }

    func url(forAPI path: String) -> URL {
        let base = baseURL.absoluteString.hasSuffix("/") ? String(baseURL.absoluteString.dropLast()) : baseURL.absoluteString
        return URL(string: base + "/api" + path)!
    }

    func webSocketURL() -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/ws"
        components.query = nil
        return components.url!
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        try await request("GET", path, body: nil)
    }

    func post<T: Decodable>(_ path: String, body: (any Encodable)? = nil) async throws -> T {
        try await request("POST", path, body: body)
    }

    func delete(_ path: String) async throws {
        let _: OK = try await request("DELETE", path, body: nil)
    }

    func request<T: Decodable>(_ method: String, _ path: String, body: (any Encodable)?, timeout: TimeInterval? = nil) async throws -> T {
        var req = URLRequest(url: url(forAPI: path))
        req.httpMethod = method
        if let timeout { req.timeoutInterval = timeout }
        authorize(&req)
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }
        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if !(200..<300).contains(status) {
            let payload = try? JSONDecoder().decode(ErrorPayload.self, from: data)
            if status == 401, payload?.code == "UNAUTHENTICATED" { onUnauthenticated?() }
            throw APIError(status: status, message: payload?.error ?? "Request failed (\(status))", code: payload?.code)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError(status: status, message: "Unexpected response from server: \(error.localizedDescription)", code: nil)
        }
    }

    private struct ErrorPayload: Decodable {
        let error: String?
        let code: String?
    }
}

struct AnyEncodable: Encodable {
    let value: any Encodable
    init(_ value: any Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

// MARK: - Endpoints

extension APIClient {
    func login(username: String, password: String) async throws -> LoginResponse {
        try await post("/auth/login", body: ["username": username, "password": password])
    }
    func authMode() async throws -> AuthMode { try await get("/auth/mode") }
    func me() async throws -> Me { try await get("/auth/me") }
    func logout() async throws -> LogoutResponse { try await post("/auth/logout") }

    func capabilities() async throws -> Capabilities { try await get("/capabilities") }

    func overview() async throws -> Overview { try await get("/system/overview") }
    func metrics() async throws -> [MetricSample] { try await get("/system/metrics") }
    func processes() async throws -> ProcessList { try await get("/system/processes") }
    func killProcess(_ pid: Int, signal: String) async throws {
        let _: OK = try await post("/system/processes/\(pid)/kill", body: ["signal": signal])
    }
    func ports() async throws -> [PortRow] { try await get("/system/ports") }
    func audit() async throws -> [AuditEntry] { try await get("/system/audit?limit=500") }

    func services() async throws -> [ServiceUnit] { try await get("/services") }
    func service(_ name: String) async throws -> ServiceDetail { try await get("/services/\(enc(name))") }
    func serviceAction(_ name: String, _ action: ServiceAction) async throws -> ServiceDetail {
        try await post("/services/\(enc(name))/\(action.rawValue)")
    }

    func dockerInfo() async throws -> DockerInfo { try await get("/docker/info") }
    func containers() async throws -> [Container] { try await get("/docker/containers") }
    func containerStats() async throws -> [String: ContainerStats] { try await get("/docker/stats") }
    func container(_ id: String) async throws -> ContainerDetail { try await get("/docker/containers/\(enc(id))") }
    func containerAction(_ id: String, _ action: ContainerAction, name: String) async throws {
        let _: OK = try await post("/docker/containers/\(enc(id))/\(action.rawValue)", body: ["name": name])
    }
    func removeContainer(_ id: String, force: Bool) async throws {
        try await delete("/docker/containers/\(enc(id))?force=\(force ? 1 : 0)")
    }
    func images() async throws -> [DockerImage] { try await get("/docker/images") }
    func pullImage(_ image: String) async throws {
        let _: OK = try await request("POST", "/docker/images/pull", body: ["image": image], timeout: 15 * 60)
    }
    func removeImage(_ id: String, force: Bool) async throws {
        try await delete("/docker/images/\(enc(id))?force=\(force ? 1 : 0)")
    }
    func volumes() async throws -> [DockerVolume] { try await get("/docker/volumes") }
    func removeVolume(_ name: String) async throws { try await delete("/docker/volumes/\(enc(name))") }
    func networks() async throws -> [DockerNetwork] { try await get("/docker/networks") }

    func k8sOverview() async throws -> K8sOverview { try await get("/kubernetes/overview") }
    func k8sWorkloads() async throws -> [K8sWorkload] { try await get("/kubernetes/workloads") }
    func k8sRestart(_ w: K8sWorkload) async throws {
        let _: OK = try await post("/kubernetes/workloads/\(w.kind)/\(enc(w.namespace))/\(enc(w.name))/restart")
    }
    func k8sScale(_ w: K8sWorkload, replicas: Int) async throws {
        let _: OK = try await post("/kubernetes/workloads/\(w.kind)/\(enc(w.namespace))/\(enc(w.name))/scale", body: ["replicas": replicas])
    }
    func k8sPods() async throws -> [K8sPod] { try await get("/kubernetes/pods") }
    func k8sDeletePod(_ pod: K8sPod) async throws { try await delete("/kubernetes/pods/\(enc(pod.namespace))/\(enc(pod.name))") }
    func k8sIngresses() async throws -> [K8sIngress] { try await get("/kubernetes/ingresses") }
    func k8sEvents() async throws -> [K8sEvent] { try await get("/kubernetes/events") }

    func sites() async throws -> SitesReport { try await get("/sites") }
    func refreshSites() async throws -> SitesReport { try await request("POST", "/sites/refresh", body: nil, timeout: 90) }
    func captureSiteThumbnail(_ host: String) async throws {
        struct R: Decodable { let ok: Bool }
        let _: R = try await request("POST", "/sites/\(enc(host))/thumbnail", body: nil, timeout: 120)
    }
    /// Raw bytes of a protected resource (used for screenshots, which need the bearer token).
    func bytes(_ path: String) async throws -> Data {
        var req = URLRequest(url: url(forAPI: path))
        authorize(&req)
        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw APIError(status: status, message: "Request failed (\(status))", code: nil) }
        return data
    }

    func kafkaCluster() async throws -> KafkaCluster { try await get("/kafka/cluster") }
    func kafkaTopics() async throws -> [KafkaTopic] { try await get("/kafka/topics") }
    func kafkaTopic(_ name: String) async throws -> KafkaTopicDetail { try await get("/kafka/topics/\(enc(name))") }
    func kafkaMessages(_ name: String, limit: Int = 20) async throws -> [KafkaMessage] {
        try await get("/kafka/topics/\(enc(name))/messages?limit=\(limit)")
    }
    func produce(_ topic: String, key: String?, value: String) async throws {
        struct Body: Encodable { let key: String?; let value: String }
        let _: OK = try await post("/kafka/topics/\(enc(topic))/messages", body: Body(key: key, value: value))
    }
    func createTopic(name: String, partitions: Int, replicationFactor: Int) async throws {
        struct Body: Encodable { let name: String; let partitions: Int; let replicationFactor: Int }
        let _: OK = try await post("/kafka/topics", body: Body(name: name, partitions: partitions, replicationFactor: replicationFactor))
    }
    func deleteTopic(_ name: String) async throws { try await delete("/kafka/topics/\(enc(name))") }
    func deleteGroup(_ id: String) async throws { try await delete("/kafka/groups/\(enc(id))") }
    func kafkaGroups() async throws -> [KafkaGroup] { try await get("/kafka/groups") }
    func kafkaGroup(_ id: String) async throws -> KafkaGroupDetail { try await get("/kafka/groups/\(enc(id))") }
}
