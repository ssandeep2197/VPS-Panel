import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Play, RotateCw, ShieldCheck, Square } from 'lucide-react';
import { useMemo, useState } from 'react';
import { endpoints, type ServiceAction, type ServiceUnit } from '../api';
import { LogViewer } from '../components/LogViewer';
import {
  Badge,
  Button,
  Card,
  EmptyState,
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
import { formatBytes } from '../utils/format';

type Filter = 'all' | 'running' | 'failed' | 'inactive';

function tone(unit: { active: string; sub: string }): Tone {
  if (unit.active === 'failed') return 'critical';
  if (unit.active === 'active') return unit.sub === 'running' ? 'good' : 'info';
  if (unit.active === 'activating' || unit.active === 'deactivating' || unit.active === 'reloading') return 'warning';
  return 'neutral';
}

const PAST: Record<ServiceAction, string> = {
  start: 'started',
  stop: 'stopped',
  restart: 'restarted',
  reload: 'reloaded',
  enable: 'enabled at boot',
  disable: 'disabled at boot',
};

function useServiceControl() {
  const queryClient = useQueryClient();
  const { confirm, attempt } = useFeedback();
  const [busy, setBusy] = useState<string | null>(null);

  const control = async (name: string, action: ServiceAction) => {
    if (action === 'stop' || action === 'disable' || action === 'restart') {
      const ok = await confirm({
        title: `${action[0].toUpperCase()}${action.slice(1)} ${name}?`,
        message:
          action === 'restart'
            ? 'The service will be briefly unavailable while it restarts.'
            : action === 'stop'
              ? 'The service will stop handling requests until it is started again.'
              : 'The service will no longer start automatically when the server boots.',
        confirmLabel: action[0].toUpperCase() + action.slice(1),
        danger: action !== 'restart',
      });
      if (!ok) return;
    }
    setBusy(`${name}:${action}`);
    await attempt(`${name} ${PAST[action]}`, () => endpoints.serviceAction(name, action));
    setBusy(null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['services'] }),
      queryClient.invalidateQueries({ queryKey: ['service', name] }),
    ]);
  };

  return { control, busy };
}

function ServiceModal({ name, onClose }: { name: string; onClose: () => void }) {
  const [tab, setTab] = useState<'logs' | 'details'>('logs');
  const detail = useQuery({ queryKey: ['service', name], queryFn: () => endpoints.service(name), refetchInterval: 5000 });
  const { control, busy } = useServiceControl();
  const d = detail.data;
  const running = d?.active === 'active';

  return (
    <Modal
      size="lg"
      onClose={onClose}
      title={
        <span className="row">
          {name}
          {d && (
            <Badge tone={tone(d)}>
              {d.active} ({d.sub})
            </Badge>
          )}
        </span>
      }
    >
      <div className="toolbar">
        <Tabs
          tabs={[
            { id: 'logs', label: 'Logs' },
            { id: 'details', label: 'Details' },
          ]}
          value={tab}
          onChange={setTab}
        />
        <span className="spacer" />
        {d && (
          <>
            {!running && (
              <Button size="sm" icon={<Play size={14} />} loading={busy === `${name}:start`} onClick={() => control(name, 'start')}>
                Start
              </Button>
            )}
            {running && (
              <Button size="sm" icon={<RotateCw size={14} />} loading={busy === `${name}:restart`} onClick={() => control(name, 'restart')}>
                Restart
              </Button>
            )}
            {running && !d.protected && (
              <Button size="sm" variant="danger" icon={<Square size={14} />} loading={busy === `${name}:stop`} onClick={() => control(name, 'stop')}>
                Stop
              </Button>
            )}
            {(d.enabled === 'enabled' || d.enabled === 'disabled') && !(d.protected && d.enabled === 'enabled') && (
              <Button
                size="sm"
                loading={busy === `${name}:enable` || busy === `${name}:disable`}
                onClick={() => control(name, d.enabled === 'enabled' ? 'disable' : 'enable')}
              >
                {d.enabled === 'enabled' ? 'Disable at boot' : 'Enable at boot'}
              </Button>
            )}
          </>
        )}
      </div>
      {tab === 'logs' ? (
        <LogViewer request={{ channel: 'service-logs', name, tail: 300 }} filename={`${name}.log`} />
      ) : (
        <QueryView query={detail}>
          {(data) => (
            <KeyValue
              items={[
                ['Description', data.description],
                ['State', `${data.active} (${data.sub})`],
                ['Start at boot', data.enabled],
                ['Main PID', data.mainPid],
                ['Memory', data.memoryBytes !== null ? formatBytes(data.memoryBytes) : null],
                ['CPU time', data.cpuSeconds !== null ? `${data.cpuSeconds.toFixed(1)} s` : null],
                ['Tasks', data.tasks],
                ['Restarts', data.restarts],
                ['Restart policy', data.restartPolicy],
                ['Active since', data.activeSince],
                ['Runs as', data.user || 'root'],
                ['Unit file', <span className="mono">{data.unitFile}</span>],
              ]}
            />
          )}
        </QueryView>
      )}
    </Modal>
  );
}

export function ServicesPage() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('running');
  const [selected, setSelected] = useState<string | null>(null);
  const caps = useQuery({ queryKey: ['capabilities'], queryFn: endpoints.capabilities, staleTime: Infinity });
  const supported = caps.data?.systemd !== false;
  const services = useQuery({
    queryKey: ['services'],
    queryFn: endpoints.services,
    refetchInterval: 10_000,
    enabled: caps.data?.systemd === true,
  });
  const { control, busy } = useServiceControl();

  const counts = useMemo(() => {
    const list = services.data ?? [];
    return {
      all: list.length,
      running: list.filter((s) => s.active === 'active').length,
      failed: list.filter((s) => s.active === 'failed').length,
      inactive: list.filter((s) => s.active === 'inactive').length,
    };
  }, [services.data]);

  if (!supported) {
    return (
      <>
        <PageHeader title="Services" subtitle="systemd units on this server" />
        <Card>
          <EmptyState
            title="Service management needs systemd"
            hint={`This host runs ${caps.data?.platform}. Services appear here when the panel runs on your Linux server.`}
          />
        </Card>
      </>
    );
  }

  const matches = (unit: ServiceUnit) => {
    if (filter === 'running' && unit.active !== 'active') return false;
    if (filter === 'failed' && unit.active !== 'failed') return false;
    if (filter === 'inactive' && unit.active !== 'inactive') return false;
    const needle = search.trim().toLowerCase();
    return !needle || unit.name.toLowerCase().includes(needle) || unit.description.toLowerCase().includes(needle);
  };

  return (
    <>
      <PageHeader title="Services" subtitle="systemd units on this server" />
      <Card flush>
        <div className="toolbar padded">
          <Tabs
            tabs={[
              { id: 'running', label: 'Active', count: counts.running },
              { id: 'failed', label: 'Failed', count: counts.failed },
              { id: 'inactive', label: 'Inactive', count: counts.inactive },
              { id: 'all', label: 'All', count: counts.all },
            ]}
            value={filter}
            onChange={setFilter}
          />
          <span className="spacer" />
          <SearchInput value={search} onChange={setSearch} placeholder="Search services…" />
        </div>
        <QueryView query={{ ...services, isLoading: services.isLoading || caps.isLoading }}>
          {(data) => {
            const rows = data.filter(matches);
            if (!rows.length) return <div className="state muted">No services match.</div>;
            return (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Service</th>
                      <th>State</th>
                      <th>At boot</th>
                      <th className="actions">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((unit) => {
                      const running = unit.active === 'active';
                      return (
                        <tr key={unit.name}>
                          <td>
                            <button type="button" className="link" onClick={() => setSelected(unit.name)}>
                              {unit.name.replace(/\.service$/, '')}
                            </button>
                            {unit.protected && (
                              <span className="inline-icon" title="Protected: cannot be stopped from the panel">
                                <ShieldCheck size={13} />
                              </span>
                            )}
                            <div className="muted small">{unit.description}</div>
                          </td>
                          <td>
                            <Badge tone={tone(unit)}>
                              {unit.active} ({unit.sub})
                            </Badge>
                          </td>
                          <td>
                            <Tag>{unit.enabled}</Tag>
                          </td>
                          <td className="actions">
                            {running ? (
                              <>
                                <Button
                                  size="sm"
                                  icon={<RotateCw size={14} />}
                                  title="Restart"
                                  aria-label={`Restart ${unit.name}`}
                                  loading={busy === `${unit.name}:restart`}
                                  onClick={() => control(unit.name, 'restart')}
                                />
                                <Button
                                  size="sm"
                                  icon={<Square size={14} />}
                                  title={unit.protected ? 'Protected service' : 'Stop'}
                                  aria-label={`Stop ${unit.name}`}
                                  disabled={unit.protected}
                                  loading={busy === `${unit.name}:stop`}
                                  onClick={() => control(unit.name, 'stop')}
                                />
                              </>
                            ) : (
                              <Button
                                size="sm"
                                icon={<Play size={14} />}
                                title="Start"
                                aria-label={`Start ${unit.name}`}
                                disabled={unit.load === 'masked'}
                                loading={busy === `${unit.name}:start`}
                                onClick={() => control(unit.name, 'start')}
                              />
                            )}
                            <Button
                              size="sm"
                              icon={<FileText size={14} />}
                              title="Logs and details"
                              aria-label={`Logs for ${unit.name}`}
                              onClick={() => setSelected(unit.name)}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          }}
        </QueryView>
      </Card>
      {selected && <ServiceModal name={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
