import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { endpoints } from '../api';
import { Badge, Card, PageHeader, QueryView, SearchInput } from '../components/ui';
import { formatDateTime } from '../utils/format';

export function ActivityPage() {
  const [search, setSearch] = useState('');
  const audit = useQuery({ queryKey: ['audit'], queryFn: endpoints.audit, refetchInterval: 15_000 });

  return (
    <>
      <PageHeader title="Activity" subtitle="Every sign-in and change made through the panel" />
      <Card flush>
        <div className="toolbar padded">
          <SearchInput value={search} onChange={setSearch} placeholder="Search activity…" />
        </div>
        <QueryView
          query={audit}
          empty={{ when: (d) => !d.length, title: 'No activity yet', hint: 'Actions you take appear here.' }}
        >
          {(data) => {
            const needle = search.trim().toLowerCase();
            const rows = data.filter(
              (e) =>
                !needle ||
                e.action.toLowerCase().includes(needle) ||
                e.target.toLowerCase().includes(needle) ||
                e.user.toLowerCase().includes(needle),
            );
            if (!rows.length) return <div className="state muted">No activity matches.</div>;
            return (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>User</th>
                      <th>Action</th>
                      <th>Target</th>
                      <th>Result</th>
                      <th>IP address</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e, i) => (
                      <tr key={`${e.ts}-${i}`}>
                        <td className="nowrap">{formatDateTime(e.ts)}</td>
                        <td>{e.user}</td>
                        <td className="mono">{e.action}</td>
                        <td className="mono">{e.target}</td>
                        <td>
                          {e.ok ? <Badge tone="good">Success</Badge> : <Badge tone="critical">Failed</Badge>}
                          {e.detail && <div className="muted small">{e.detail}</div>}
                        </td>
                        <td className="mono small">{e.ip}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }}
        </QueryView>
      </Card>
    </>
  );
}
