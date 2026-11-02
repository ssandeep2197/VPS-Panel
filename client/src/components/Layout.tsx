import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Boxes,
  Cog,
  Cpu,
  Globe,
  LayoutDashboard,
  LogOut,
  Moon,
  Server,
  Ship,
  Sun,
  Waypoints,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { endpoints } from '../api';
import { useAuth } from '../auth';
import { Button } from './ui';

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/services', label: 'Services', icon: Cog },
  { to: '/docker', label: 'Docker', icon: Boxes },
  { to: '/kubernetes', label: 'Kubernetes', icon: Ship },
  { to: '/requests', label: 'Requests', icon: Globe },
  { to: '/kafka', label: 'Kafka', icon: Waypoints },
  { to: '/processes', label: 'Processes', icon: Cpu },
  { to: '/activity', label: 'Activity', icon: Activity },
];

type Theme = 'light' | 'dark';

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('vps_panel_theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // ignore
  }
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function Layout() {
  const { username, logout } = useAuth();
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const overview = useQuery({ queryKey: ['overview'], queryFn: endpoints.overview, staleTime: 60_000 });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('vps_panel_theme', theme);
    } catch {
      // ignore
    }
  }, [theme]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Server size={20} />
          <div>
            <strong>VPS Panel</strong>
            <span className="muted small">{overview.data?.hostname ?? ' '}</span>
          </div>
        </div>
        <nav>
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? 'nav active' : 'nav')}>
              <Icon size={17} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="muted small user">{username}</span>
          <Button
            variant="ghost"
            size="sm"
            icon={theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title="Toggle theme"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={<LogOut size={16} />}
            aria-label="Sign out"
            title="Sign out"
            onClick={logout}
          />
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
