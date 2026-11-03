import { useQuery } from '@tanstack/react-query';
import { Server } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { endpoints } from '../api';
import { useAuth } from '../auth';
import { Button } from '../components/ui';
import { errorText } from '../utils/format';

export function LoginPage() {
  const { login, loginTms } = useAuth();
  const mode = useQuery({ queryKey: ['auth-mode'], queryFn: endpoints.authMode, staleTime: Infinity, retry: 1 });
  const [useTms, setUseTms] = useState<boolean | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (useTms === null && mode.data) setUseTms(mode.data.tms);
  }, [mode.data, useTms]);

  const tms = useTms === true;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (tms) await loginTms(username, password);
      else await login(username, password);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <Server size={22} />
          <div>
            <strong>VPS Panel</strong>
            <span className="muted small">{tms ? 'Sign in with your TMS account' : 'Sign in to manage this server'}</span>
          </div>
        </div>
        <label className="field">
          <span>{tms ? 'Email' : 'Username'}</span>
          <input
            type={tms ? 'email' : 'text'}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && (
          <div className="notice notice-critical" role="alert">
            {error}
          </div>
        )}
        <Button type="submit" variant="primary" loading={busy}>
          Sign in
        </Button>
        {mode.data?.tms && (
          <button
            type="button"
            className="link small muted"
            onClick={() => {
              setUseTms(!tms);
              setError(null);
            }}
          >
            {tms ? "Use the panel's own admin password instead" : 'Sign in with your TMS account instead'}
          </button>
        )}
      </form>
    </div>
  );
}
