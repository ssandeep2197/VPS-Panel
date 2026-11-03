import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { endpoints, LOGOUT_EVENT, setToken, type Me } from './api';

interface AuthState {
  username: string | null;
  /** Who is signed in (name, role, whether they may change things). */
  me: Me | null;
  ready: boolean;
  /** The panel's own admin password. */
  login: (username: string, password: string) => Promise<void>;
  /** Sign in with TMS: a browser round trip through the TMS sign-in page. */
  loginTms: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // A stored token or the session cookie from a TMS sign-in: either way the server says who we are
    endpoints
      .me()
      .then(setMe)
      .catch(() => setToken(null))
      .finally(() => setReady(true));
  }, []);

  const logout = useCallback(() => {
    const viaTms = me?.via === 'tms';
    setToken(null);
    setMe(null);
    queryClient.clear();
    endpoints
      .logout()
      .then((r) => {
        // Also end the TMS single sign-on, so the next sign-in asks for the password again
        if (viaTms && r.logoutUrl) window.location.assign(r.logoutUrl);
      })
      .catch(() => undefined);
  }, [queryClient, me]);

  useEffect(() => {
    window.addEventListener(LOGOUT_EVENT, logout);
    return () => window.removeEventListener(LOGOUT_EVENT, logout);
  }, [logout]);

  const login = useCallback(async (user: string, password: string) => {
    const result = await endpoints.login(user, password);
    setToken(result.token);
    setMe(await endpoints.me());
  }, []);

  const loginTms = useCallback(() => {
    const to = window.location.pathname + window.location.search;
    window.location.assign(`/auth/login?to=${encodeURIComponent(to === '/login' ? '/' : to)}`);
  }, []);

  const value = useMemo(
    () => ({ username: me?.username ?? null, me, ready, login, loginTms, logout }),
    [me, ready, login, loginTms, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
