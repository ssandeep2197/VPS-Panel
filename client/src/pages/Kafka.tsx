import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError, endpoints } from '../api';
import {
  Badge,
  Button,
  Card,
  KeyValue,
  Modal,
  PageHeader,
  QueryView,
  SearchInput,
  Tabs,
  Tag,
  useFeedback,
  type Tone,
} from '../components/ui';
import { errorText, formatDateTime, formatNumber } from '../utils/format';

type Tab = 'topics' | 'groups' | 'brokers';

function groupTone(state: string): Tone {
  if (state === 'Stable') return 'good';
  if (state === 'Empty') return 'neutral';
  if (state === 'Dead') return 'critical';
  return 'warning';
}

function CreateTopicModal({ brokers, onClose }: { brokers: number; onClose: () => void }) {
  const [name, setName] = useState('');
  const [partitions, setPartitions] = useState(1);
  const [replicationFactor, setReplicationFactor] = useState(1);
  const [busy, setBusy] = useState(false);
  const { attempt } = useFeedback();
  const queryClient = useQueryClient();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await attempt(`Topic ${name} created`, () =>
      endpoints.createTopic({ name: name.trim(), partitions, replicationFactor }),
    );
    setBusy(false);
    if (ok) {
      await queryClient.invalidateQueries({ queryKey: ['kafka'] });
      onClose();
    }
  };

  return (
    <Modal title="Create topic" size="sm" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>Topic name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            pattern="[A-Za-z0-9._\-]+"
            maxLength={249}
            placeholder="orders.created"
            autoFocus
            required
          />
          <span className="muted small">Letters, numbers, dots, underscores and hyphens.</span>
        </label>
        <div className="field-row">
          <label className="field">
            <span>Partitions</span>
            <input type="number" min={1} max={1000} value={partitions} onChange={(e) => setPartitions(Number(e.target.value))} required />
          </label>
          <label className="field">
            <span>Replication factor</span>
            <input
              type="number"
              min={1}
              max={Math.max(1, brokers)}
              value={replicationFactor}
              onChange={(e) => setReplicationFactor(Number(e.target.value))}
              required
            />
          </label>
        </div>
        <span className="muted small">
          Replication factor cannot exceed the number of brokers ({brokers}).
        </span>
        <div className="form-foot">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>
            Create topic
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function TopicModal({ name, onClose }: { name: string; onClose: () => void }) {
  const [tab, setTab] = useState<'partitions' | 'messages' | 'produce' | 'config'>('partitions');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const { attempt } = useFeedback();
  const queryClient = useQueryClient();

  const topic = useQuery({ queryKey: ['kafka', 'topic', name], queryFn: () => endpoints.kafkaTopic(name) });
  const messages = useQuery({
    queryKey: ['kafka', 'messages', name],
    queryFn: () => endpoints.kafkaMessages(name, 25),
    enabled: tab === 'messages',
    gcTime: 0,
  });

  const produce = async (e: FormEvent) => {
    e.preventDefault();
    setSending(true);
    const ok = await attempt(`Message sent to ${name}`, () => endpoints.produce(name, key || null, value));
    setSending(false);
    if (ok) {
      setValue('');
      await queryClient.invalidateQueries({ queryKey: ['kafka'] });
    }
  };

  return (
    <Modal title={name} size="lg" onClose={onClose}>
      <div className="toolbar">
        <Tabs
          tabs={[
            { id: 'partitions', label: 'Partitions', count: topic.data?.partitions.length },
            { id: 'messages', label: 'Latest messages' },
            { id: 'produce', label: 'Produce' },
            { id: 'config', label: 'Configuration' },
          ]}
          value={tab}
          onChange={setTab}
        />
        <span className="spacer" />
        {tab === 'messages' && (
          <Button size="sm" icon={<RefreshCw size={14} />} loading={messages.isFetching} onClick={() => void messages.refetch()}>
            Refresh
          </Button>
        )}
      </div>

      {tab === 'partitions' && (
        <QueryView query={topic}>
          {(d) => (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="num">Partition</th>
                    <th className="num">Leader</th>
                    <th>Replicas</th>
                    <th>In sync</th>
                    <th className="num">Start offset</th>
                    <th className="num">End offset</th>
                    <th className="num">Messages</th>
                  </tr>
                </thead>
                <tbody>
                  {d.partitions.map((p) => (
                    <tr key={p.partition}>
                      <td className="num">{p.partition}</td>
                      <td className="num">{p.leader}</td>
                      <td>{p.replicas.join(', ')}</td>
                      <td>
                        {p.isr.length < p.replicas.length ? (
                          <Badge tone="warning">{p.isr.join(', ') || 'none'}</Badge>
                        ) : (
                          p.isr.join(', ')
                        )}
                      </td>
                      <td className="num">{formatNumber(Number(p.low))}</td>
                      <td className="num">{formatNumber(Number(p.high))}</td>
                      <td className="num">{formatNumber(Number(p.high) - Number(p.low))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryView>
      )}

      {tab === 'messages' && (
        <QueryView
          query={messages}
          empty={{ when: (d) => !d.length, title: 'No messages', hint: 'This topic is empty.' }}
        >
          {(d) => (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="num">Partition</th>
                    <th className="num">Offset</th>
                    <th>Time</th>
                    <th>Key</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {d.map((m) => (
                    <tr key={`${m.partition}-${m.offset}`}>
                      <td className="num">{m.partition}</td>
                      <td className="num">{m.offset}</td>
                      <td className="nowrap small">{formatDateTime(Number(m.timestamp))}</td>
                      <td className="mono small">{m.key ?? <span className="muted">null</span>}</td>
                      <td>
                        <pre className="message">{m.value ?? 'null'}</pre>
                        {m.truncated && <span className="muted small">Truncated to 4,000 characters</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryView>
      )}

      {tab === 'produce' && (
        <form className="form" onSubmit={produce}>
          <label className="field">
            <span>Key (optional)</span>
            <input value={key} onChange={(e) => setKey(e.target.value)} />
          </label>
          <label className="field">
            <span>Value</span>
            <textarea rows={8} className="mono" value={value} onChange={(e) => setValue(e.target.value)} placeholder='{"hello": "world"}' required />
          </label>
          <div className="form-foot">
            <Button type="submit" variant="primary" icon={<Send size={14} />} loading={sending}>
              Send message
            </Button>
          </div>
        </form>
      )}

      {tab === 'config' && (
        <QueryView query={topic} empty={{ when: (d) => !d.config.length, title: 'Configuration unavailable' }}>
          {(d) => (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Setting</th>
                    <th>Value</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {d.config.map((c) => (
                    <tr key={c.name}>
                      <td className="mono">{c.name}</td>
                      <td className="mono">{c.value || '–'}</td>
                      <td>{c.isDefault ? <span className="muted">Default</span> : <Tag>Overridden</Tag>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryView>
      )}
    </Modal>
  );
}

function Topics({ brokers }: { brokers: number }) {
  const [search, setSearch] = useState('');
  const [showInternal, setShowInternal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, attempt } = useFeedback();
  const queryClient = useQueryClient();
  const topics = useQuery({ queryKey: ['kafka', 'topics'], queryFn: endpoints.kafkaTopics, refetchInterval: 15_000 });

  const remove = async (name: string) => {
    const ok = await confirm({
      title: `Delete topic ${name}?`,
      message: 'Every message in this topic is permanently deleted. Producers and consumers using it will fail.',
      confirmLabel: 'Delete topic',
      danger: true,
    });
    if (!ok) return;
    setBusy(name);
    await attempt(`Topic ${name} deleted`, () => endpoints.deleteTopic(name));
    setBusy(null);
    await queryClient.invalidateQueries({ queryKey: ['kafka'] });
  };

  return (
    <>
      <div className="toolbar padded">
        <SearchInput value={search} onChange={setSearch} placeholder="Search topics…" />
        <label className="check">
          <input type="checkbox" checked={showInternal} onChange={(e) => setShowInternal(e.target.checked)} />
          Show internal topics
        </label>
        <span className="spacer" />
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
          Create topic
        </Button>
      </div>
      <QueryView query={topics}>
        {(data) => {
          const needle = search.trim().toLowerCase();
          const rows = data.filter(
            (t) => (showInternal || !t.internal) && (!needle || t.name.toLowerCase().includes(needle)),
          );
          if (!rows.length) {
            return (
              <div className="state">
                <strong>No topics</strong>
                <span className="muted">{data.length ? 'No topics match.' : 'Create a topic to get started.'}</span>
              </div>
            );
          }
          return (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Topic</th>
                    <th className="num">Partitions</th>
                    <th className="num">Replication</th>
                    <th>Health</th>
                    <th className="num">Messages</th>
                    <th className="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => (
                    <tr key={t.name}>
                      <td>
                        <button type="button" className="link mono" onClick={() => setSelected(t.name)}>
                          {t.name}
                        </button>
                        {t.internal && <Tag>internal</Tag>}
                      </td>
                      <td className="num">{t.partitions}</td>
                      <td className="num">{t.replicationFactor}</td>
                      <td>
                        {t.underReplicated ? (
                          <Badge tone="warning">{t.underReplicated} under-replicated</Badge>
                        ) : (
                          <Badge tone="good">In sync</Badge>
                        )}
                      </td>
                      <td className="num">{formatNumber(t.messages)}</td>
                      <td className="actions">
                        <Button size="sm" icon={<Eye size={14} />} title="Open" aria-label={`Open ${t.name}`} onClick={() => setSelected(t.name)} />
                        <Button
                          size="sm"
                          variant="danger"
                          icon={<Trash2 size={14} />}
                          title={t.internal ? 'Internal topics cannot be deleted' : 'Delete'}
                          aria-label={`Delete ${t.name}`}
                          disabled={t.internal}
                          loading={busy === t.name}
                          onClick={() => remove(t.name)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </QueryView>
      {creating && <CreateTopicModal brokers={brokers} onClose={() => setCreating(false)} />}
      {selected && <TopicModal name={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function GroupModal({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const group = useQuery({
    queryKey: ['kafka', 'group', groupId],
    queryFn: () => endpoints.kafkaGroup(groupId),
    refetchInterval: 5000,
  });
  return (
    <Modal title={groupId} size="lg" onClose={onClose}>
      <QueryView query={group}>
        {(d) => (
          <div className="stack">
            <KeyValue
              items={[
                ['State', <Badge tone={groupTone(d.state)}>{d.state}</Badge>],
                ['Total lag', formatNumber(d.totalLag)],
                ['Members', d.members.length],
                ['Protocol', d.protocol],
              ]}
            />
            {d.members.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Client</th>
                      <th>Host</th>
                      <th>Member ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.members.map((m) => (
                      <tr key={m.memberId}>
                        <td>{m.clientId}</td>
                        <td className="mono">{m.host}</td>
                        <td className="mono small">{m.memberId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {d.offsets.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Topic</th>
                      <th className="num">Partition</th>
                      <th className="num">Committed</th>
                      <th className="num">End offset</th>
                      <th className="num">Lag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.offsets.map((o) => (
                      <tr key={`${o.topic}-${o.partition}`}>
                        <td className="mono">{o.topic}</td>
                        <td className="num">{o.partition}</td>
                        <td className="num">{o.committed !== null ? formatNumber(Number(o.committed)) : '–'}</td>
                        <td className="num">{o.end !== null ? formatNumber(Number(o.end)) : '–'}</td>
                        <td className="num">{o.lag !== null ? formatNumber(o.lag) : '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="state muted">This group has no committed offsets.</div>
            )}
          </div>
        )}
      </QueryView>
    </Modal>
  );
}

function Groups() {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, attempt } = useFeedback();
  const queryClient = useQueryClient();
  const groups = useQuery({ queryKey: ['kafka', 'groups'], queryFn: endpoints.kafkaGroups, refetchInterval: 10_000 });

  const remove = async (groupId: string) => {
    const ok = await confirm({
      title: `Delete group ${groupId}?`,
      message: 'Committed offsets are deleted. A consumer that rejoins starts from its configured reset position.',
      confirmLabel: 'Delete group',
      danger: true,
    });
    if (!ok) return;
    setBusy(groupId);
    await attempt(`Group ${groupId} deleted`, () => endpoints.deleteGroup(groupId));
    setBusy(null);
    await queryClient.invalidateQueries({ queryKey: ['kafka', 'groups'] });
  };

  return (
    <>
      <div className="toolbar padded">
        <SearchInput value={search} onChange={setSearch} placeholder="Search consumer groups…" />
      </div>
      <QueryView
        query={groups}
        empty={{ when: (d) => !d.length, title: 'No consumer groups', hint: 'Groups appear once a consumer connects.' }}
      >
        {(data) => {
          const needle = search.trim().toLowerCase();
          const rows = data.filter((g) => !needle || g.groupId.toLowerCase().includes(needle));
          if (!rows.length) return <div className="state muted">No groups match.</div>;
          return (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Group</th>
                    <th>State</th>
                    <th className="num">Members</th>
                    <th className="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((g) => (
                    <tr key={g.groupId}>
                      <td>
                        <button type="button" className="link mono" onClick={() => setSelected(g.groupId)}>
                          {g.groupId}
                        </button>
                      </td>
                      <td>
                        <Badge tone={groupTone(g.state)}>{g.state}</Badge>
                      </td>
                      <td className="num">{g.members}</td>
                      <td className="actions">
                        <Button size="sm" icon={<Eye size={14} />} title="Offsets and lag" aria-label={`Open ${g.groupId}`} onClick={() => setSelected(g.groupId)} />
                        <Button
                          size="sm"
                          variant="danger"
                          icon={<Trash2 size={14} />}
                          title={g.members ? 'Group has active members' : 'Delete'}
                          aria-label={`Delete ${g.groupId}`}
                          disabled={g.members > 0}
                          loading={busy === g.groupId}
                          onClick={() => remove(g.groupId)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }}
      </QueryView>
      {selected && <GroupModal groupId={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

export function KafkaPage() {
  const [tab, setTab] = useState<Tab>('topics');
  const cluster = useQuery({ queryKey: ['kafka', 'cluster'], queryFn: endpoints.kafkaCluster, refetchInterval: 15_000 });
  const notConfigured = cluster.error instanceof ApiError && cluster.error.code === 'KAFKA_NOT_CONFIGURED';

  return (
    <>
      <PageHeader
        title="Kafka"
        subtitle={
          cluster.data
            ? `${cluster.data.brokers.length} ${cluster.data.brokers.length === 1 ? 'broker' : 'brokers'} · bootstrap ${cluster.data.bootstrap.join(', ')}`
            : undefined
        }
        actions={
          cluster.data ? (
            <Badge tone="good">Connected</Badge>
          ) : cluster.error ? (
            <Badge tone={notConfigured ? 'neutral' : 'critical'}>{notConfigured ? 'Not configured' : 'Unreachable'}</Badge>
          ) : null
        }
      />
      {cluster.isLoading ? (
        <Card>
          <div className="state muted">Connecting to Kafka…</div>
        </Card>
      ) : !cluster.data ? (
        <Card>
          <div className="state">
            <strong>{notConfigured ? 'Kafka is not configured' : 'Cannot reach Kafka'}</strong>
            <span className="muted">
              {notConfigured ? (
                <>
                  Set <code>KAFKA_BROKERS</code> in <code>server/.env</code> (for example{' '}
                  <code>localhost:9092</code>) and restart the panel.
                </>
              ) : (
                errorText(cluster.error)
              )}
            </span>
            {!notConfigured && (
              <Button size="sm" icon={<RefreshCw size={14} />} loading={cluster.isFetching} onClick={() => void cluster.refetch()}>
                Retry
              </Button>
            )}
            <span className="muted small">
              To start or stop the broker itself, use the Services or Docker page, depending on how Kafka is installed.
            </span>
          </div>
        </Card>
      ) : (
        <Card flush>
          <div className="toolbar padded">
            <Tabs
              tabs={[
                { id: 'topics', label: 'Topics' },
                { id: 'groups', label: 'Consumer groups' },
                { id: 'brokers', label: 'Brokers', count: cluster.data.brokers.length },
              ]}
              value={tab}
              onChange={setTab}
            />
          </div>
          {tab === 'topics' && <Topics brokers={cluster.data.brokers.length} />}
          {tab === 'groups' && <Groups />}
          {tab === 'brokers' && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="num">Node ID</th>
                    <th>Host</th>
                    <th className="num">Port</th>
                    <th>Role</th>
                  </tr>
                </thead>
                <tbody>
                  {cluster.data.brokers.map((b) => (
                    <tr key={b.nodeId}>
                      <td className="num">{b.nodeId}</td>
                      <td className="mono">{b.host}</td>
                      <td className="num">{b.port}</td>
                      <td>{b.isController ? <Tag>Controller</Tag> : <span className="muted">Broker</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
