import Foundation

struct OK: Decodable { let ok: Bool }

struct Capabilities: Decodable {
    let systemd: Bool
    let kafka: Bool
    let kubernetes: Bool
    let platform: String
}

struct LoginResponse: Decodable {
    let token: String
    let username: String
}

// MARK: - System

struct Disk: Decodable, Identifiable {
    var id: String { mount }
    let fs: String
    let type: String
    let mount: String
    let size: Double
    let used: Double
    let usePercent: Double
}

struct Overview: Decodable {
    let hostname: String
    let platform: String
    let distro: String
    let kernel: String
    let arch: String
    let cpuModel: String
    let cpuCores: Int
    let uptime: Double
    let disks: [Disk]
}

struct MetricSample: Decodable, Identifiable {
    var id: Double { ts }
    let ts: Double
    let cpu: Double
    let memUsed: Double
    let memTotal: Double
    let swapUsed: Double
    let swapTotal: Double
    let load: [Double]
    let rxSec: Double
    let txSec: Double

    var date: Date { Date(timeIntervalSince1970: ts / 1000) }
}

struct ProcessRow: Decodable, Identifiable {
    var id: Int { pid }
    let pid: Int
    let parentPid: Int
    let name: String
    let user: String
    let cpu: Double
    let mem: Double
    let memRss: Double
    let state: String
    let started: String
    let command: String
}

struct ProcessList: Decodable {
    let total: Int
    let running: Int
    let sleeping: Int
    let list: [ProcessRow]
}

struct PortRow: Decodable, Identifiable {
    var id: String { "\(proto) \(address):\(port)" }
    let proto: String
    let address: String
    let port: Int
    let pid: Int?
    let process: String

    enum CodingKeys: String, CodingKey {
        case proto = "protocol", address, port, pid, process
    }
}

struct AuditEntry: Decodable, Identifiable {
    var id = UUID()
    let ts: String
    let user: String
    let ip: String
    let action: String
    let target: String
    let ok: Bool
    let detail: String?

    enum CodingKeys: String, CodingKey { case ts, user, ip, action, target, ok, detail }
}

// MARK: - systemd

struct ServiceUnit: Decodable, Identifiable {
    var id: String { name }
    let name: String
    let description: String
    let load: String
    let active: String
    let sub: String
    let enabled: String
    let protected: Bool
}

struct ServiceDetail: Decodable {
    let name: String
    let description: String
    let load: String
    let active: String
    let sub: String
    let enabled: String
    let protected: Bool
    let mainPid: Int?
    let memoryBytes: Double?
    let cpuSeconds: Double?
    let tasks: Int?
    let restarts: Int?
    let restartPolicy: String
    let activeSince: String
    let unitFile: String
    let execStart: String
    let user: String
}

enum ServiceAction: String, CaseIterable {
    case start, stop, restart, reload, enable, disable
}

// MARK: - Docker

struct DockerInfo: Decodable {
    let version: String
    let apiVersion: String
    let os: String
    let containers: Int
    let running: Int
    let paused: Int
    let stopped: Int
    let images: Int
    let cpus: Int
    let memTotal: Double
    let storageDriver: String
}

struct Container: Decodable, Identifiable {
    let id: String
    let name: String
    let image: String
    let state: String
    let status: String
    let created: Double
    let project: String?
    let ports: [String]
}

struct ContainerMount: Decodable, Identifiable {
    var id: String { destination }
    let type: String
    let source: String
    let destination: String
    let rw: Bool
}

struct ContainerNetwork: Decodable, Identifiable {
    var id: String { name }
    let name: String
    let ip: String
}

struct ContainerDetail: Decodable {
    let id: String
    let name: String
    let image: String
    let created: String
    let state: String
    let startedAt: String
    let finishedAt: String
    let exitCode: Int
    let health: String?
    let restartCount: Int
    let restartPolicy: String
    let command: String
    let envNames: [String]
    let mounts: [ContainerMount]
    let networks: [ContainerNetwork]
    let ports: [String]
}

struct ContainerStats: Decodable {
    let cpu: Double
    let memUsed: Double
    let memLimit: Double
    let netRx: Double
    let netTx: Double
}

enum ContainerAction: String, CaseIterable {
    case start, stop, restart, pause, unpause, kill
}

struct DockerImage: Decodable, Identifiable {
    let id: String
    let tags: [String]
    let size: Double
    let created: Double
    let inUse: Bool
}

struct DockerVolume: Decodable, Identifiable {
    var id: String { name }
    let name: String
    let driver: String
    let mountpoint: String
    let created: String?
    let usedBy: [String]
}

struct DockerNetwork: Decodable, Identifiable {
    let id: String
    let name: String
    let driver: String
    let scope: String
    let subnet: String?
    let isInternal: Bool

    enum CodingKeys: String, CodingKey { case id, name, driver, scope, subnet, isInternal = "internal" }
}

// MARK: - Kafka

struct KafkaBroker: Decodable, Identifiable {
    var id: Int { nodeId }
    let nodeId: Int
    let host: String
    let port: Int
    let isController: Bool
}

struct KafkaCluster: Decodable {
    let clusterId: String
    let controller: Int?
    let bootstrap: [String]
    let brokers: [KafkaBroker]
}

struct KafkaTopic: Decodable, Identifiable {
    var id: String { name }
    let name: String
    let isInternal: Bool
    let partitions: Int
    let replicationFactor: Int
    let underReplicated: Int
    let messages: Double

    enum CodingKeys: String, CodingKey { case name, isInternal = "internal", partitions, replicationFactor, underReplicated, messages }
}

struct KafkaPartition: Decodable, Identifiable {
    var id: Int { partition }
    let partition: Int
    let leader: Int
    let replicas: [Int]
    let isr: [Int]
    let low: String
    let high: String
}

struct KafkaConfigEntry: Decodable, Identifiable {
    var id: String { name }
    let name: String
    let value: String
    let isDefault: Bool
}

struct KafkaTopicDetail: Decodable {
    let name: String
    let messages: Double
    let partitions: [KafkaPartition]
    let config: [KafkaConfigEntry]
}

struct KafkaMessage: Decodable, Identifiable {
    var id: String { "\(partition)-\(offset)" }
    let partition: Int
    let offset: String
    let timestamp: String
    let key: String?
    let value: String?
    let truncated: Bool
}

struct KafkaGroup: Decodable, Identifiable {
    var id: String { groupId }
    let groupId: String
    let state: String
    let `protocol`: String
    let members: Int
}

struct KafkaMember: Decodable, Identifiable {
    var id: String { memberId }
    let memberId: String
    let clientId: String
    let host: String
}

struct KafkaOffset: Decodable, Identifiable {
    var id: String { "\(topic)-\(partition)" }
    let topic: String
    let partition: Int
    let committed: String?
    let end: String?
    let lag: Double?
}

struct KafkaGroupDetail: Decodable {
    let groupId: String
    let state: String
    let `protocol`: String
    let members: [KafkaMember]
    let offsets: [KafkaOffset]
    let totalLag: Double
}

// MARK: - Kubernetes

struct K8sNode: Decodable, Identifiable {
    var id: String { name }
    let name: String
    let ready: Bool
    let version: String
    let os: String
    let roles: [String]
}

struct K8sOverview: Decodable {
    let nodes: [K8sNode]
    let namespaces: [String]
    let protectedNamespaces: [String]
}

struct K8sWorkload: Decodable, Identifiable {
    var id: String { "\(kind)/\(namespace)/\(name)" }
    let kind: String
    let namespace: String
    let name: String
    let desired: Int
    let ready: Int
    let updated: Int
    let images: [String]
    let created: String
    let scalable: Bool
}

struct K8sContainer: Decodable, Identifiable {
    var id: String { name }
    let name: String
    let image: String
}

struct K8sPod: Decodable, Identifiable {
    var id: String { "\(namespace)/\(name)" }
    let namespace: String
    let name: String
    let status: String
    let phase: String
    let ready: Int
    let total: Int
    let restarts: Int
    let containers: [K8sContainer]
    let owner: String?
    let node: String?
    let ip: String?
    let created: String
    let cpuMilli: Double?
    let memory: Double?
}

struct K8sHost: Decodable, Identifiable {
    var id: String { host }
    let host: String
    let tls: Bool
}

struct K8sCertificate: Decodable {
    let ready: Bool
    let message: String
    let expires: String?
}

struct K8sIngress: Decodable, Identifiable {
    var id: String { "\(namespace)/\(name)" }
    let namespace: String
    let name: String
    let className: String?
    let hosts: [K8sHost]
    let backends: [String]
    let certificate: K8sCertificate?
    let created: String
}

struct K8sEvent: Decodable, Identifiable {
    var id = UUID()
    let namespace: String
    let object: String
    let reason: String
    let message: String
    let count: Int
    let lastSeen: String

    enum CodingKeys: String, CodingKey { case namespace, object, reason, message, count, lastSeen }
}

// MARK: - Ingress requests

struct AccessEntry: Decodable, Identifiable {
    let id: String
    let ts: Double
    let client: String
    let host: String
    let method: String
    let path: String
    let `protocol`: String
    let status: Int
    let bytes: Double
    let duration: Double
    let referer: String
    let userAgent: String
    let namespace: String
    let service: String
    let upstream: String
    let upstreamStatus: Int?
}
