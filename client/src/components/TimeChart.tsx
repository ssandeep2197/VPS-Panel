import { useEffect, useMemo, useRef, useState } from 'react';
import { formatClock } from '../utils/format';

export interface ChartSeries {
  name: string;
  /** CSS colour, normally a var(--series-n) token so it follows the theme. */
  color: string;
  values: number[];
}

interface Props {
  title: string;
  timestamps: number[];
  series: ChartSeries[];
  format: (value: number) => string;
  /** Fixed top of the y axis (e.g. 100 for percentages). Otherwise derived from the data. */
  max?: number;
  /** 1024 for byte quantities so ticks land on clean KB/MB values. */
  base?: 10 | 1024;
  height?: number;
}

const M = { top: 10, right: 14, bottom: 22, left: 72 };
// Multiples of 4 so the five ticks (0, ¼, ½, ¾, 1) all land on round values
const STEPS = [1, 2, 4, 8, 20, 40, 80, 200, 400, 800];

function niceMax(max: number, base: number): number {
  if (max <= 0) return base === 1024 ? 1024 : 1;
  const unit = base ** Math.floor(Math.log(max) / Math.log(base));
  for (const step of STEPS) if (step * unit >= max) return step * unit;
  return unit * base;
}

export function TimeChart({ title, timestamps, series, format, max, base = 10, height = 190 }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const n = timestamps.length;
  const innerW = width - M.left - M.right;
  const innerH = height - M.top - M.bottom;

  const top = useMemo(() => {
    if (max !== undefined) return max;
    let peak = 0;
    for (const s of series) for (const v of s.values) if (v > peak) peak = v;
    return niceMax(peak, base);
  }, [series, max, base]);

  const t0 = timestamps[0] ?? 0;
  const t1 = timestamps[n - 1] ?? 1;
  const x = (i: number) => M.left + (t1 === t0 ? innerW : ((timestamps[i] - t0) / (t1 - t0)) * innerW);
  const y = (v: number) => M.top + innerH - (Math.min(v, top) / top) * innerH;

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * top);
  const index = hover !== null && hover < n ? hover : null;

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - rect.left) / rect.width) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < n; i++) {
      if (Math.abs(timestamps[i] - t) < Math.abs(timestamps[best] - t)) best = i;
    }
    setHover(best);
  };

  const latest = series.map((s) => `${s.name} ${format(s.values[n - 1] ?? 0)}`).join(', ');

  return (
    <figure className="chart viz-root">
      <figcaption className="chart-head">
        <span className="chart-title">{title}</span>
        {series.length > 1 && (
          <span className="legend">
            {series.map((s) => (
              <span key={s.name} className="legend-item">
                <span className="legend-key" style={{ background: s.color }} />
                {s.name}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <div className="chart-plot" ref={wrap}>
        <svg width={width} height={height} role="img" aria-label={`${title}. Latest: ${latest}`}>
          {ticks.map((tick) => (
            <g key={tick}>
              <line className="gridline" x1={M.left} x2={width - M.right} y1={y(tick)} y2={y(tick)} />
              <text className="tick" x={M.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                {format(tick)}
              </text>
            </g>
          ))}
          {n > 1 && (
            <>
              <text className="tick" x={M.left} y={height - 6} textAnchor="start">
                {formatClock(t0)}
              </text>
              <text className="tick" x={width - M.right} y={height - 6} textAnchor="end">
                {formatClock(t1)}
              </text>
            </>
          )}
          {n > 1 &&
            series.map((s) => {
              const line = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
              const floor = M.top + innerH;
              return (
                <g key={s.name}>
                  <path d={`${line}L${x(n - 1).toFixed(1)},${floor}L${x(0).toFixed(1)},${floor}Z`} fill={s.color} opacity={0.1} />
                  <path d={line} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                </g>
              );
            })}
          {index !== null && (
            <g pointerEvents="none">
              <line className="crosshair" x1={x(index)} x2={x(index)} y1={M.top} y2={M.top + innerH} />
              {series.map((s) => (
                <circle
                  key={s.name}
                  cx={x(index)}
                  cy={y(s.values[index] ?? 0)}
                  r={4}
                  fill={s.color}
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              ))}
            </g>
          )}
          <rect
            x={M.left}
            y={M.top}
            width={Math.max(0, innerW)}
            height={Math.max(0, innerH)}
            fill="transparent"
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          />
        </svg>
        {index !== null && (
          <div
            className="chart-tip"
            style={
              x(index) > width / 2
                ? { right: width - x(index) + 12, top: M.top }
                : { left: x(index) + 12, top: M.top }
            }
          >
            <div className="muted small">{formatClock(timestamps[index])}</div>
            {series.map((s) => (
              <div key={s.name} className="chart-tip-row">
                <span className="legend-key" style={{ background: s.color }} />
                <span>{s.name}</span>
                <strong>{format(s.values[index] ?? 0)}</strong>
              </div>
            ))}
          </div>
        )}
        {n <= 1 && <div className="chart-empty muted">Collecting samples…</div>}
      </div>
    </figure>
  );
}
