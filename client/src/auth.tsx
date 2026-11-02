import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { endpoints, getToken, LOGOUT_EVENT, setToken } from './api';

interface AuthState {
  username: string | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      setReady(true);
      return;
    }
    endpoints
      .me()
      .then((me) => setUsername(me.username))
      .catch(() => setToken(null))
      .finally(() => setReady(true));
  }, []);

  const logout = useCallback(() => {
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

  const value = useMemo(() => ({ username, ready, login, logout }), [username, ready, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
