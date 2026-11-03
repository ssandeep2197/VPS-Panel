import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { endpoints, LOGOUT_EVENT, setToken, tmsLogin } from './api';

interface AuthState {
  username: string | null;
  ready: boolean;
  /** The panel's own admin password. */
  login: (username: string, password: string) => Promise<void>;
  /** A TMS account (single sign-on). */
  loginTms: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // A stored token or the TMS session cookie: either way the server says who we are
    endpoints
      .me()
      .then((me) => setUsername(me.username))
      .catch(() => setToken(null))
      .finally(() => setReady(true));
  }, []);

  const logout = useCallback(() => {
    void endpoints.logout().catch(() => undefined);
    setToken(null);
    setUsername(null);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    window.addEventListener(LOGOUT_EVENT, logout);
    return () => window.removeEventListener(LOGOUT_EVENT, logout);
  }, [logout]);

  const login = useCallback(async (user: string, password: string) => {
    const result = await endpoints.login(user, password);
    setToken(result.token);
    setUsername(result.username);
  }, []);

  const loginTms = useCallback(async (email: string, password: string) => {
    const result = await tmsLogin(email, password);
    setToken(null);
    setUsername(result.username);
  }, []);

  const value = useMemo(
    () => ({ username, ready, login, loginTms, logout }),
    [username, ready, login, loginTms, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
