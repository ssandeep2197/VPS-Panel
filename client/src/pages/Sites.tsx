import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Camera, ExternalLink, Globe, RefreshCw } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { endpoints, type SiteBackend, type SiteCheck, type SiteStatus } from '../api';
import { Badge, Button, Card, PageHeader, QueryView, SearchInput, useFeedback, type Tone } from '../components/ui';
import { errorText, formatAgo, formatDateTime } from '../utils/format';

const STATUS: Record<SiteStatus, { tone: Tone; label: string }> = {
  ok: { tone: 'good', label: 'Working' },
  degraded: { tone: 'warning', label: 'Working with warnings' },
  down: { tone: 'critical', label: 'Not working' },
  unknown: { tone: 'neutral', label: 'Unknown' },
};

function Count({ label, value, tone }: { label: string; value: number; tone?: Tone }) {
  return (
    <div className="count">
      <span className="tile-label">{label}</span>
      <span className="count-value">
        {value}
        {tone && value > 0 && <Badge tone={tone}>{label}</Badge>}
      </span>
    </div>
  );
}

/** Loads the screenshot through the API (an <img> tag cannot send the bearer token). */
function Thumbnail({ site }: { site: SiteCheck }) {
  const query = useQuery({
    queryKey: ['site-thumb', site.host, site.thumbnailAt],
    queryFn: () => endpoints.siteThumbnail(site.host),
    enabled: Boolean(site.thumbnailAt),
    staleTime: Infinity,
    retry: false,
  });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!query.data) return;
    const next = URL.createObjectURL(query.data);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [query.data]);

  return (
    <a className="site-thumb" href={site.url} target="_blank" rel="noreferrer" title={`Open ${site.host}`}>
      {url ? (
        <img src={url} alt={`Screenshot of ${site.host}`} loading="lazy" />
      ) : (
        <span className="site-initial" aria-hidden>
          {site.name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <span className="site-thumb-badge">
        <Badge tone={STATUS[site.status].tone}>{STATUS[site.status].label}</Badge>
      </span>
    </a>
  );
}

function backendText(b: SiteBackend): string {
  if (b.kind === 'missing') return `${b.service}: no endpoints`;
  if (b.kind === 'pods') {
    const img = b.pods[0]?.image ? ` · ${b.pods[0].image.split('/').pop()}` : '';
    return `${b.ready}/${b.total} pods ready${img}`;
  }
  if (b.container) return `container ${b.container.name} · ${b.container.state}`;
  return `${b.addresses.join(', ') || 'no address'}${b.reachable === false ? ' · unreachable' : ''}`;
}

function certText(site: SiteCheck): string {
  const t = site.tls;
  if (t.placeholder) return 'placeholder (none issued)';
  if (t.error && !t.subject) return t.error;
  const issuer = t.issuer?.includes("Let's Encrypt") ? "Let's Encrypt" : (t.issuer ?? 'unknown issuer');
  if (t.daysLeft === null) return issuer;
  if (t.daysLeft < 0) return `${issuer} · expired`;
  return `${issuer} · ${t.daysLeft} days left`;
}

function responseText(site: SiteCheck): string {
  const h = site.http;
  if (h.status === null) return h.error ?? 'no response';
  const ms = h.latencyMs !== null ? ` · ${h.latencyMs >= 1000 ? `${(h.latencyMs / 1000).toFixed(1)}s` : `${h.latencyMs}ms`}` : '';
  return `HTTP ${h.status}${ms}`;
}

function SiteCard({ site }: { site: SiteCheck }) {
  const feedback = useFeedback();
  const queryClient = useQueryClient();
  const capture = useMutation({
    mutationFn: () => endpoints.captureSiteThumbnail(site.host),
    onSuccess: () => {
      feedback.notify(`New screenshot of ${site.host}`, 'good');
      void queryClient.invalidateQueries({ queryKey: ['sites'] });
    },
    onError: (err) => feedback.notify(errorText(err), 'critical'),
  });

  return (
    <article className={`site-card ${site.status === 'down' ? 'site-down' : ''}`}>
      <Thumbnail site={site} />
      <div className="site-body">
        <div className="site-title">
          <strong title={site.http.title ?? site.name}>{site.name}</strong>
          {site.namespace && <span className="muted small nowrap">{site.namespace}</span>}
        </div>
        <a className="site-host mono" href={site.url} target="_blank" rel="noreferrer">
          {site.host} <ExternalLink size={11} />
        </a>
        <dl className="site-facts">
          <dt>Response</dt>
          <dd title={site.http.title ?? undefined}>{responseText(site)}</dd>
          <dt>Certificate</dt>
          <dd title={site.tls.expires ? `Expires ${formatDateTime(site.tls.expires)}` : undefined}>{certText(site)}</dd>
          {site.backends.map((b) => (
            <Fragment key={b.service}>
              <dt>Backend</dt>
              <dd title={b.service}>{backendText(b)}</dd>
            </Fragment>
          ))}
          <dt>DNS</dt>
          <dd>
            {site.dns.addresses.length
              ? `${site.dns.addresses.join(', ')}${site.dns.pointsHere === false ? ' (not this server)' : ''}`
              : 'no record'}
          </dd>
        </dl>
        {site.problems.length > 0 && (
          <ul className="site-problems">
            {site.problems.map((p) => (
              <li key={p}>
                <AlertTriangle size={14} />
                <span>{p}</span>
              </li>
            ))}
          </ul>
        )}
        {site.notes.length > 0 && (
          <ul className="site-notes">
            {site.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        <div className="site-foot">
          <span className="muted small">
            {site.thumbnailAt ? `Screenshot ${formatAgo(site.thumbnailAt)}` : 'No screenshot yet'} · checked {formatAgo(site.checkedAt)}
          </span>
          <Button variant="ghost" size="sm" onClick={() => capture.mutate()} disabled={capture.isPending} title="Take a new screenshot">
            <Camera size={14} />
          </Button>
        </div>
      </div>
    </article>
  );
}


export function SitesPage() {
  const [search, setSearch] = useState('');
  const [problemsOnly, setProblemsOnly] = useState(false);
  const feedback = useFeedback();
  const queryClient = useQueryClient();
  const sites = useQuery({ queryKey: ['sites'], queryFn: endpoints.sites, refetchInterval: 30_000 });
  const refresh = useMutation({
    mutationFn: endpoints.refreshSites,
    onSuccess: (data) => queryClient.setQueryData(['sites'], data),
    onError: (err) => feedback.notify(errorText(err), 'critical'),
  });

  const counts = useMemo(() => {
    const list = sites.data?.sites ?? [];
    return {
      total: list.length,
      ok: list.filter((s) => s.status === 'ok').length,
      degraded: list.filter((s) => s.status === 'degraded').length,
      down: list.filter((s) => s.status === 'down').length,
    };
  }, [sites.data]);

  return (
    <>
      <PageHeader
        title="Sites"
        subtitle={
          sites.data?.checkedAt
            ? `Every hostname served by this server, checked from the server itself · last check ${formatAgo(sites.data.checkedAt)}`
            : 'Every hostname served by this server, checked from the server itself'
        }
        actions={
          <Button onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            <RefreshCw size={14} className={refresh.isPending ? 'spin' : undefined} /> Check now
          </Button>
        }
      />
      <div className="grid counts">
        <Count label="Sites" value={counts.total} />
        <Count label="Working" value={counts.ok} />
        <Count label="Warnings" value={counts.degraded} tone="warning" />
        <Count label="Not working" value={counts.down} tone="critical" />
      </div>
      <Card flush>
        <div className="toolbar padded">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by name or host…" />
          <label className="row small">
            <input type="checkbox" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} /> Problems only
          </label>
        </div>
        <QueryView
          query={sites}
          empty={{
            when: (d) => !d.sites.length,
            title: 'No sites found',
            hint: sites.data?.discovery ?? 'Sites are discovered from the ingress rules in the cluster. Add SITES to server/.env for others.',
          }}
        >
          {(data) => {
            const needle = search.trim().toLowerCase();
            const list = data.sites.filter(
              (s) =>
                (!problemsOnly || s.status !== 'ok') &&
                (!needle || s.host.includes(needle) || s.name.toLowerCase().includes(needle)),
            );
            return (
              <div style={{ padding: 14 }}>
                {data.discovery && (
                  <div className="state muted" style={{ paddingTop: 0 }}>
                    <Globe size={14} /> {data.discovery}
                  </div>
                )}
                {!data.thumbnails && <div className="muted small">Screenshots are off (THUMBNAILS=false).</div>}
                {list.length ? (
                  <div className="grid sites" style={{ marginBottom: 0 }}>
                    {list.map((s) => (
                      <SiteCard key={s.host} site={s} />
                    ))}
                  </div>
                ) : (
                  <div className="state muted">No sites match.</div>
                )}
              </div>
            );
          }}
        </QueryView>
      </Card>
    </>
  );
}
