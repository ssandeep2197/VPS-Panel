import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { endpoints, type MetricSample } from '../api';
import { TimeChart } from '../components/TimeChart';
import { Badge, Card, Meter, PageHeader, QueryView, type Tone } from '../components/ui';
import { useStream } from '../hooks/useStream';
import { errorText, formatBytes, formatDuration, formatNumber, formatPercent, formatRate } from '../utils/format';

const MAX_SAMPLES = 200;

type MetricsMessage = { type: 'history'; samples: MetricSample[] } | { type: 'sample'; sample: MetricSample };

function StatTile({
  label,
  value,
  detail,
  percent,
}: {
  label: string;
  value: string;
  detail: string;
  percent?: number;
}) {
  return (
    <div className="tile">
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {percent !== undefined && <Meter value={percent} label={label} />}
      <span className="muted small">{detail}</span>
    </div>
  );
}

function SummaryCard({
  title,
  to,
  query,
  disabled,
  children,
}: {
  title: string;
  to: string;
  query: { isLoading: boolean; error: unknown; data: unknown };
  /** Shown instead of the data when the feature is switched off on this host. */
  disabled?: string | false;
  children: ReactNode;
}) {
  return (
    <Link to={to} className="summary">
      <span className="tile-label">{title}</span>
      {disabled ? (
        <>
          <Badge tone="neutral">Not available</Badge>
          <span className="muted small">{disabled}</span>
        </>
      ) : query.isLoading || (query.data === undefined && !query.error) ? (
        <span className="muted">Loading…</span>
      ) : query.data === undefined ? (
        <>
          <Badge tone="critical">Unreachable</Badge>
          <span className="muted small">{errorText(query.error)}</span>
        </>
      ) : (
        children
      )}
    </Link>
  );
}

export function DashboardPage() {
  const [samples, setSamples] = useState<MetricSample[]>([]);

  const onMessage = useCallback((message: MetricsMessage) => {
    if (message.type === 'history') setSamples(message.samples.slice(-MAX_SAMPLES));
    else if (message.type === 'sample') setSamples((prev) => [...prev, message.sample].slice(-MAX_SAMPLES));
  }, []);
  const request = useMemo(() => ({ channel: 'metrics' }), []);
  const { status } = useStream<MetricsMessage>({ request, onMessage });

  const overview = useQuery({ queryKey: ['overview'], queryFn: endpoints.overview, refetchInterval: 60_000 });
  const docker = useQuery({ queryKey: ['docker', 'info'], queryFn: endpoints.dockerInfo, refetchInterval: 15_000 });
  const caps = useQuery({ queryKey: ['capabilities'], queryFn: endpoints.capabilities, staleTime: Infinity });
  const sites = useQuery({ queryKey: ['sites'], queryFn: endpoints.sites, refetchInterval: 30_000 });
  const sitesDown = sites.data?.sites.filter((s) => s.status === 'down') ?? [];
  const sitesWarn = sites.data?.sites.filter((s) => s.status === 'degraded') ?? [];
  const services = useQuery({
    queryKey: ['services'],
    queryFn: endpoints.services,
    refetchInterval: 15_000,
    enabled: caps.data?.systemd === true,
  });
  const pods = useQuery({
    queryKey: ['k8s', 'pods'],
    queryFn: endpoints.k8sPods,
    refetchInterval: 15_000,
    enabled: caps.data?.kubernetes === true,
  });
  const kafka = useQuery({
    queryKey: ['kafka', 'cluster'],
    queryFn: endpoints.kafkaCluster,
    refetchInterval: 30_000,
    enabled: caps.data?.kafka === true,
  });

  const last = samples[samples.length - 1];
  const timestamps = useMemo(() => samples.map((s) => s.ts), [samples]);
  const memPercent = last ? (last.memUsed / last.memTotal) * 100 : 0;
  const swapPercent = last && last.swapTotal ? (last.swapUsed / last.swapTotal) * 100 : 0;
  const cores = overview.data?.cpuCores ?? 1;

  const failed = services.data?.filter((s) => s.active === 'failed') ?? [];
  const liveTone: Tone = status === 'open' ? 'good' : 'info';

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={
          overview.data
            ? `${overview.data.hostname} · ${overview.data.distro} · kernel ${overview.data.kernel} · up ${formatDuration(overview.data.uptime)}`
            : 'Loading host information…'
        }
        actions={<Badge tone={liveTone}>{status === 'open' ? 'Live' : 'Reconnecting'}</Badge>}
      />

      <div className="grid tiles">
        <StatTile
          label="CPU"
          value={last ? formatPercent(last.cpu) : '–'}
          percent={last?.cpu ?? 0}
          detail={overview.data ? `${cores} cores · ${overview.data.cpuModel}` : ' '}
        />
        <StatTile
          label="Memory"
          value={last ? formatPercent(memPercent) : '–'}
          percent={memPercent}
          detail={last ? `${formatBytes(last.memUsed)} of ${formatBytes(last.memTotal)}` : ' '}
        />
        <StatTile
          label="Swap"
          value={last ? (last.swapTotal ? formatPercent(swapPercent) : 'None') : '–'}
          percent={swapPercent}
          detail={last?.swapTotal ? `${formatBytes(last.swapUsed)} of ${formatBytes(last.swapTotal)}` : 'No swap configured'}
        />
        <StatTile
          label="Load average"
          value={last ? last.load[0].toFixed(2) : '–'}
          percent={last ? (last.load[0] / cores) * 100 : 0}
          detail={last ? `5m ${last.load[1].toFixed(2)} · 15m ${last.load[2].toFixed(2)}` : ' '}
        />
      </div>

      <div className="grid summaries">
        <SummaryCard title="Sites" to="/sites" query={sites}>
          <span className="tile-value">
            {formatNumber(sites.data?.sites.filter((s) => s.status === 'ok').length ?? 0)}
            <span className="tile-unit"> of {sites.data?.sites.length ?? 0} working</span>
          </span>
          {sitesDown.length ? (
            <Badge tone="critical">{sitesDown.length} not working</Badge>
          ) : sitesWarn.length ? (
            <Badge tone="warning">{sitesWarn.length} with warnings</Badge>
          ) : (
            <Badge tone="good">All sites up</Badge>
          )}
          {sitesDown.length > 0 && <span className="muted small">{sitesDown.map((s) => s.host).join(', ')}</span>}
        </SummaryCard>
        <SummaryCard
          title="Services"
          to="/services"
          query={services}
          disabled={caps.data?.systemd === false && 'systemd is not available on this host'}
        >
          <span className="tile-value">
            {formatNumber(services.data?.filter((s) => s.active === 'active').length ?? 0)}
            <span className="tile-unit"> active</span>
          </span>
          {failed.length ? (
            <Badge tone="critical">{failed.length} failed</Badge>
          ) : (
            <Badge tone="good">No failures</Badge>
          )}
        </SummaryCard>
        <SummaryCard title="Docker" to="/docker" query={docker}>
          <span className="tile-value">
            {docker.data?.running ?? 0}
            <span className="tile-unit"> of {docker.data?.containers ?? 0} running</span>
          </span>
          <span className="muted small">
            {docker.data?.images} images · Docker {docker.data?.version}
          </span>
        </SummaryCard>
        <SummaryCard
          title="Kubernetes"
          to="/kubernetes"
          query={pods}
          disabled={caps.data?.kubernetes === false && 'kubectl was not found on this host'}
        >
          {(() => {
            const live = (pods.data ?? []).filter((p) => p.status !== 'Completed');
            const unhealthy = live.filter((p) => p.status !== 'Running');
            return (
              <>
                <span className="tile-value">
                  {live.length - unhealthy.length}
                  <span className="tile-unit"> of {live.length} pods running</span>
                </span>
                {unhealthy.length ? (
                  <Badge tone="critical">{unhealthy.length} unhealthy</Badge>
                ) : (
                  <Badge tone="good">All healthy</Badge>
                )}
              </>
            );
          })()}
        </SummaryCard>
        <SummaryCard
          title="Kafka"
          to="/kafka"
          query={kafka}
          disabled={caps.data?.kafka === false && 'Set KAFKA_BROKERS in server/.env'}
        >
          <span className="tile-value">
            {kafka.data?.brokers.length ?? 0}
            <span className="tile-unit"> {kafka.data?.brokers.length === 1 ? 'broker' : 'brokers'}</span>
          </span>
          <Badge tone="good">Connected</Badge>
        </SummaryCard>
      </div>

      <div className="grid charts">
        <Card>
          <TimeChart
            title="CPU usage"
            timestamps={timestamps}
            series={[{ name: 'CPU', color: 'var(--series-1)', values: samples.map((s) => s.cpu) }]}
            format={(v) => formatPercent(v, 0)}
            max={100}
          />
        </Card>
        <Card>
          <TimeChart
            title="Memory usage"
            timestamps={timestamps}
            series={[
              {
                name: 'Memory',
                color: 'var(--series-1)',
                values: samples.map((s) => (s.memUsed / s.memTotal) * 100),
              },
            ]}
            format={(v) => formatPercent(v, 0)}
            max={100}
          />
        </Card>
        <Card>
          <TimeChart
            title="Network throughput"
            timestamps={timestamps}
            series={[
              { name: 'Received', color: 'var(--series-1)', values: samples.map((s) => s.rxSec) },
              { name: 'Sent', color: 'var(--series-2)', values: samples.map((s) => s.txSec) },
            ]}
            format={formatRate}
            base={1024}
          />
        </Card>
        <Card title="Disks" flush>
          <QueryView query={overview} empty={{ when: (d) => !d.disks.length, title: 'No disks reported' }}>
            {(data) => (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Mount</th>
                      <th>Usage</th>
                      <th className="num">Used</th>
                      <th className="num">Size</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.disks.map((disk) => (
                      <tr key={disk.fs + disk.mount}>
                        <td>
                          <div className="mono">{disk.mount}</div>
                          <div className="muted small">
                            {disk.fs} · {disk.type}
                          </div>
                        </td>
                        <td className="meter-cell">
                          <Meter value={disk.usePercent} label={`${disk.mount} usage`} />
                          <span className="small">{formatPercent(disk.usePercent, 0)}</span>
                        </td>
                        <td className="num">{formatBytes(disk.used)}</td>
                        <td className="num">{formatBytes(disk.size)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </QueryView>
        </Card>
      </div>
    </>
  );
}
