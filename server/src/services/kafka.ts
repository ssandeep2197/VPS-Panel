import crypto from 'crypto';
import { ConfigResourceTypes, Kafka, logLevel, type Admin, type KafkaConfig, type SASLOptions } from 'kafkajs';
import { config } from '../config';
import { errorMessage, HttpError } from '../utils/http';

const TOPIC_RE = /^[A-Za-z0-9._-]{1,249}$/;
const GROUP_RE = /^[\x21-\x7e]{1,255}$/;

let kafka: Kafka | null = null;
let admin: Admin | null = null;
let connecting: Promise<Admin> | null = null;

export function isConfigured(): boolean {
  return config.kafka.brokers.length > 0;
}

function sasl(): SASLOptions | undefined {
  const { saslMechanism, saslUsername, saslPassword } = config.kafka;
  if (!saslMechanism) return undefined;
  if (saslMechanism !== 'plain' && saslMechanism !== 'scram-sha-256' && saslMechanism !== 'scram-sha-512') {
    throw new HttpError(500, `Unsupported KAFKA_SASL_MECHANISM "${saslMechanism}"`);
  }
  return { mechanism: saslMechanism, username: saslUsername, password: saslPassword } as SASLOptions;
}

function client(): Kafka {
  if (!isConfigured()) {
    throw new HttpError(503, 'Kafka is not configured. Set KAFKA_BROKERS in server/.env', 'KAFKA_NOT_CONFIGURED');
  }
  if (!kafka) {
    const options: KafkaConfig = {
      clientId: config.kafka.clientId,
      brokers: config.kafka.brokers,
      ssl: config.kafka.ssl,
      sasl: sasl(),
      connectionTimeout: 4000,
      requestTimeout: 15_000,
      // Fail fast so the UI reports an unreachable broker instead of hanging
      retry: { retries: 1, initialRetryTime: 200 },
      logLevel: logLevel.NOTHING,
    };
    kafka = new Kafka(options);
  }
  return kafka;
}

async function getAdmin(): Promise<Admin> {
  if (admin) return admin;
  if (!connecting) {
    const candidate = client().admin();
    connecting = candidate
      .connect()
      .then(() => {
        admin = candidate;
        candidate.on(candidate.events.DISCONNECT, () => {
          if (admin === candidate) admin = null;
        });
        return candidate;
      })
      .finally(() => {
        connecting = null;
      });
  }
  return connecting;
}

async function withAdmin<T>(fn: (admin: Admin) => Promise<T>): Promise<T> {
  try {
    return await fn(await getAdmin());
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Drop the connection so the next request reconnects from scratch
    const stale = admin;
    admin = null;
    stale?.disconnect().catch(() => undefined);
    throw new HttpError(503, `Kafka: ${errorMessage(err)}`, 'KAFKA_UNAVAILABLE');
  }
}

export function assertTopic(name: string): string {
  if (!TOPIC_RE.test(name) || name === '.' || name === '..') throw new HttpError(400, 'Invalid topic name');
  return name;
}

export function assertGroup(id: string): string {
  if (!GROUP_RE.test(id)) throw new HttpError(400, 'Invalid consumer group id');
  return id;
}

export function getCluster() {
  return withAdmin(async (a) => {
    const cluster = await a.describeCluster();
    return {
      clusterId: cluster.clusterId,
      controller: cluster.controller,
      bootstrap: config.kafka.brokers,
      brokers: cluster.brokers
        .map((b) => ({ nodeId: b.nodeId, host: b.host, port: b.port, isController: b.nodeId === cluster.controller }))
        .sort((x, y) => x.nodeId - y.nodeId),
    };
  });
}

function sumMessages(offsets: Array<{ high: string; low: string }>): number {
  return offsets.reduce((sum, o) => sum + Number(BigInt(o.high) - BigInt(o.low)), 0);
}

export function listTopics() {
  return withAdmin(async (a) => {
    const { topics } = await a.fetchTopicMetadata();
    const rows = await Promise.all(
      topics.map(async (t) => {
        const offsets = await a.fetchTopicOffsets(t.name).catch(() => []);
        const underReplicated = t.partitions.filter((p) => p.isr.length < p.replicas.length).length;
        return {
          name: t.name,
          internal: t.name.startsWith('__'),
          partitions: t.partitions.length,
          replicationFactor: t.partitions[0]?.replicas.length ?? 0,
          underReplicated,
          messages: sumMessages(offsets),
        };
      }),
    );
    return rows.sort((x, y) => x.name.localeCompare(y.name));
  });
}

export function getTopic(name: string) {
  assertTopic(name);
  return withAdmin(async (a) => {
    const [{ topics }, offsets, configs] = await Promise.all([
      a.fetchTopicMetadata({ topics: [name] }),
      a.fetchTopicOffsets(name),
      a
        .describeConfigs({ includeSynonyms: false, resources: [{ type: ConfigResourceTypes.TOPIC, name }] })
        .catch(() => null),
    ]);
    const meta = topics[0];
    if (!meta) throw new HttpError(404, `Topic ${name} not found`);
    const byPartition = new Map(offsets.map((o) => [o.partition, o]));
    return {
      name,
      messages: sumMessages(offsets),
      partitions: meta.partitions
        .map((p) => ({
          partition: p.partitionId,
          leader: p.leader,
          replicas: p.replicas,
          isr: p.isr,
          low: byPartition.get(p.partitionId)?.low ?? '0',
          high: byPartition.get(p.partitionId)?.high ?? '0',
        }))
        .sort((x, y) => x.partition - y.partition),
      config: (configs?.resources[0]?.configEntries ?? [])
        .filter((c) => !c.isSensitive)
        .map((c) => ({ name: c.configName, value: c.configValue, isDefault: c.isDefault }))
        .sort((x, y) => Number(x.isDefault) - Number(y.isDefault) || x.name.localeCompare(y.name)),
    };
  });
}

export function createTopic(name: string, partitions: number, replicationFactor: number) {
  assertTopic(name);
  return withAdmin(async (a) => {
    const created = await a.createTopics({
      waitForLeaders: true,
      topics: [{ topic: name, numPartitions: partitions, replicationFactor }],
    });
    if (!created) throw new HttpError(409, `Topic ${name} already exists`);
  });
}

export function deleteTopic(name: string) {
  assertTopic(name);
  if (name.startsWith('__')) throw new HttpError(403, 'Internal topics cannot be deleted from the panel');
  return withAdmin((a) => a.deleteTopics({ topics: [name] }));
}

export function listGroups() {
  return withAdmin(async (a) => {
    const { groups } = await a.listGroups();
    if (!groups.length) return [];
    const described = await a.describeGroups(groups.map((g) => g.groupId));
    return described.groups
      .map((g) => ({
        groupId: g.groupId,
        state: g.state,
        protocol: g.protocol,
        members: g.members.length,
      }))
      .sort((x, y) => x.groupId.localeCompare(y.groupId));
  });
}

export function getGroup(groupId: string) {
  assertGroup(groupId);
  return withAdmin(async (a) => {
    const [described, committed] = await Promise.all([
      a.describeGroups([groupId]),
      a.fetchOffsets({ groupId }),
    ]);
    const group = described.groups[0];
    const offsets = await Promise.all(
      committed.map(async (t) => {
        const latest = await a.fetchTopicOffsets(t.topic).catch(() => []);
        const high = new Map(latest.map((o) => [o.partition, o.high]));
        return t.partitions.map((p) => {
          const end = high.get(p.partition);
          const hasCommit = Number(p.offset) >= 0;
          return {
            topic: t.topic,
            partition: p.partition,
            committed: hasCommit ? p.offset : null,
            end: end ?? null,
            lag: hasCommit && end !== undefined ? Math.max(0, Number(BigInt(end) - BigInt(p.offset))) : null,
          };
        });
      }),
    );
    const flat = offsets.flat().sort((x, y) => x.topic.localeCompare(y.topic) || x.partition - y.partition);
    return {
      groupId,
      state: group?.state ?? 'Unknown',
      protocol: group?.protocol ?? '',
      members: (group?.members ?? []).map((m) => ({
        memberId: m.memberId,
        clientId: m.clientId,
        host: m.clientHost,
      })),
      offsets: flat,
      totalLag: flat.reduce((sum, o) => sum + (o.lag ?? 0), 0),
    };
  });
}

export function deleteGroup(groupId: string) {
  assertGroup(groupId);
  return withAdmin((a) => a.deleteGroups([groupId]));
}

export async function produceMessage(topic: string, key: string | null, value: string): Promise<void> {
  assertTopic(topic);
  const producer = client().producer({ allowAutoTopicCreation: false });
  try {
    await producer.connect();
    await producer.send({ topic, messages: [{ key: key || null, value }] });
  } catch (err) {
    throw new HttpError(503, `Kafka: ${errorMessage(err)}`, 'KAFKA_UNAVAILABLE');
  } finally {
    await producer.disconnect().catch(() => undefined);
  }
}

export interface PeekedMessage {
  partition: number;
  offset: string;
  timestamp: string;
  key: string | null;
  value: string | null;
  truncated: boolean;
}

const MAX_VALUE_CHARS = 4000;

/**
 * Reads the newest messages of a topic with a throwaway consumer group that
 * never commits, so real consumers are unaffected.
 */
export async function peekMessages(topic: string, limit: number): Promise<PeekedMessage[]> {
  assertTopic(topic);
  const offsets = await withAdmin((a) => a.fetchTopicOffsets(topic));
  const targets = offsets
    .map((o) => ({ partition: o.partition, low: BigInt(o.low), high: BigInt(o.high) }))
    .filter((o) => o.high > o.low);
  if (!targets.length) return [];

  const perPartition = BigInt(Math.max(1, Math.ceil(limit / targets.length)));
  const groupId = `vps-panel-peek-${crypto.randomUUID()}`;
  const consumer = client().consumer({ groupId, allowAutoTopicCreation: false, sessionTimeout: 10_000 });
  const messages: PeekedMessage[] = [];
  const finished = new Set<number>();
  const lastOffset = new Map(targets.map((t) => [t.partition, t.high - 1n]));

  try {
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, 8000);
      consumer
        .run({
          autoCommit: false,
          eachMessage: async ({ partition, message }) => {
            const last = lastOffset.get(partition);
            if (last === undefined || finished.has(partition)) return;
            const raw = message.value?.toString('utf8') ?? null;
            messages.push({
              partition,
              offset: message.offset,
              timestamp: message.timestamp,
              key: message.key?.toString('utf8') ?? null,
              value: raw && raw.length > MAX_VALUE_CHARS ? raw.slice(0, MAX_VALUE_CHARS) : raw,
              truncated: Boolean(raw && raw.length > MAX_VALUE_CHARS),
            });
            if (BigInt(message.offset) >= last) finished.add(partition);
            if (finished.size === targets.length) {
              clearTimeout(timeout);
              resolve();
            }
          },
        })
        .then(() => {
          for (const t of targets) {
            const start = t.high - perPartition > t.low ? t.high - perPartition : t.low;
            consumer.seek({ topic, partition: t.partition, offset: start.toString() });
          }
        })
        .catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
    });
  } catch (err) {
    throw new HttpError(503, `Kafka: ${errorMessage(err)}`, 'KAFKA_UNAVAILABLE');
  } finally {
    await consumer.disconnect().catch(() => undefined);
    void withAdmin((a) => a.deleteGroups([groupId])).catch(() => undefined);
  }

  return messages
    .sort((x, y) => Number(BigInt(y.timestamp) - BigInt(x.timestamp)) || Number(BigInt(y.offset) - BigInt(x.offset)))
    .slice(0, limit);
}

export async function disconnectKafka(): Promise<void> {
  await admin?.disconnect().catch(() => undefined);
  admin = null;
}
