import Foundation
import Observation

/// Opens one authenticated WebSocket stream against `/ws` and reconnects with backoff if it drops.
/// Mirrors the web client's `useStream` hook: the first message selects the channel.
@MainActor
@Observable
final class StreamClient {
    enum Status { case connecting, open, closed, error }

    private(set) var status: Status = .connecting
    private(set) var error: String?

    private let api: APIClient
    private let request: [String: Any]
    private let onMessage: (Data) -> Void
    private let onOpen: () -> Void
    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var attempts = 0
    private var disposed = false
    private var ended = false
    private var generation = 0

    init(api: APIClient, request: [String: Any], onOpen: @escaping () -> Void = {}, onMessage: @escaping (Data) -> Void) {
        self.api = api
        self.request = request
        self.onOpen = onOpen
        self.onMessage = onMessage
    }

    func start() {
        disposed = false
        ended = false
        connect()
    }

    func stop() {
        disposed = true
        receiveTask?.cancel()
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    private func connect() {
        guard !disposed else { return }
        status = .connecting
        generation += 1
        let gen = generation
        let socket = URLSession.shared.webSocketTask(with: api.webSocketURL())
        task = socket
        socket.resume()

        var start = request
        start["token"] = api.token ?? ""
        let payload = (try? JSONSerialization.data(withJSONObject: start)) ?? Data()
        socket.send(.data(payload)) { [weak self] err in
            Task { @MainActor in
                guard let self, self.generation == gen else { return }
                if let err { self.handleClose(err); return }
                self.status = .open
                self.error = nil
                self.onOpen()
            }
        }

        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let message = try await socket.receive()
                    guard let self, self.generation == gen else { return }
                    self.attempts = 0
                    let data: Data
                    switch message {
                    case .data(let d): data = d
                    case .string(let s): data = Data(s.utf8)
                    @unknown default: continue
                    }
                    if let envelope = try? JSONDecoder().decode(Envelope.self, from: data) {
                        if envelope.type == "error" {
                            self.ended = true
                            self.error = envelope.error ?? "Stream error"
                            self.status = .error
                            return
                        }
                        if envelope.type == "end" { self.ended = true }
                    }
                    self.onMessage(data)
                } catch {
                    guard let self, self.generation == gen else { return }
                    self.handleClose(error)
                    return
                }
            }
        }
    }

    private func handleClose(_ err: Error?) {
        if disposed { return }
        if ended {
            if status != .error { status = .closed }
            return
        }
        status = .connecting
        attempts += 1
        let delay = min(15.0, pow(2.0, Double(min(attempts, 4))))
        let gen = generation
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !self.disposed, self.generation == gen else { return }
            self.connect()
        }
    }

    private struct Envelope: Decodable {
        let type: String?
        let error: String?
    }
}

/// Simple loader state used by every list page: keeps the last good value while refreshing.
@MainActor
@Observable
final class Loader<Value> {
    private(set) var value: Value?
    private(set) var error: String?
    private(set) var isLoading = false

    func load(_ op: () async throws -> Value) async {
        if value == nil { isLoading = true }
        do {
            value = try await op()
            error = nil
        } catch is CancellationError {
        } catch let err as URLError where err.code == .cancelled {
        } catch {
            self.error = error.localizedDescription
        }
        isLoading = false
    }

    /// Loads immediately and then every `seconds` until the enclosing task is cancelled.
    func poll(every seconds: Double, _ op: @escaping () async throws -> Value) async {
        while !Task.isCancelled {
            await load(op)
            try? await Task.sleep(for: .seconds(seconds))
        }
    }
}
