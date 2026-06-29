// Phase 3-D: Auth 状态管理（React Context）
//
// 提供：
//   - user / accessToken / refreshToken / isAuthenticated / isLoading
//   - login / logout / refresh / loadMe 方法
//
// token 存储在 localStorage，页面刷新后可恢复。

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';

// ── 类型 ──

export interface AuthUser {
  id: string;
  tenantId: string;
  role: string;
  username: string;
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<string | null>;
  loadMe: () => Promise<void>;
}

// ── localStorage keys ──

const LS_ACCESS_TOKEN = 'daopai_access_token';
const LS_REFRESH_TOKEN = 'daopai_refresh_token';
const LS_USER = 'daopai_user';

function loadTokens(): { accessToken: string | null; refreshToken: string | null; user: AuthUser | null } {
  try {
    return {
      accessToken: localStorage.getItem(LS_ACCESS_TOKEN),
      refreshToken: localStorage.getItem(LS_REFRESH_TOKEN),
      user: JSON.parse(localStorage.getItem(LS_USER) || 'null'),
    };
  } catch {
    return { accessToken: null, refreshToken: null, user: null };
  }
}

function saveTokens(accessToken: string, refreshToken: string, user: AuthUser) {
  localStorage.setItem(LS_ACCESS_TOKEN, accessToken);
  localStorage.setItem(LS_REFRESH_TOKEN, refreshToken);
  localStorage.setItem(LS_USER, JSON.stringify(user));
}

function clearTokens() {
  localStorage.removeItem(LS_ACCESS_TOKEN);
  localStorage.removeItem(LS_REFRESH_TOKEN);
  localStorage.removeItem(LS_USER);
}

// ── Context ──

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => {
    const { accessToken, refreshToken, user } = loadTokens();
    return {
      user,
      accessToken,
      refreshToken,
      isAuthenticated: !!(accessToken && user),
      isLoading: !!(accessToken && user), // 有 token 时需验证
    };
  });

  // 启动时恢复用户状态
  useEffect(() => {
    const { accessToken, refreshToken } = loadTokens();
    if (!accessToken || !refreshToken) {
      setState(s => ({ ...s, isLoading: false }));
      return;
    }
    // 调用 /api/auth/me 验证 token 是否有效
    fetch('/api/auth/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
      .then(res => {
        if (!res.ok) throw new Error('token invalid');
        return res.json();
      })
      .then((data: AuthUser) => {
        setState({
          user: { id: data.id, tenantId: data.tenantId, role: data.role, username: data.username || '' },
          accessToken,
          refreshToken,
          isAuthenticated: true,
          isLoading: false,
        });
      })
      .catch(() => {
        // token 无效，清除
        clearTokens();
        setState({
          user: null,
          accessToken: null,
          refreshToken: null,
          isAuthenticated: false,
          isLoading: false,
        });
      });
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const resp = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || '登录失败');
    }
    const user: AuthUser = {
      id: data.user.id,
      tenantId: data.user.tenantId,
      role: data.user.role,
      username: data.user.username,
    };
    saveTokens(data.accessToken, data.refreshToken, user);
    setState({
      user,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      isAuthenticated: true,
      isLoading: false,
    });
  }, []);

  const logout = useCallback(async () => {
    const { refreshToken } = loadTokens();
    if (refreshToken) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
      } catch {
        // logout 失败也不阻塞
      }
    }
    clearTokens();
    setState({
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: false,
    });
  }, []);

  const refresh = useCallback(async (): Promise<string | null> => {
    const { refreshToken } = loadTokens();
    if (!refreshToken) return null;
    try {
      const resp = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!resp.ok) {
        clearTokens();
        setState(s => ({ ...s, isAuthenticated: false, accessToken: null, refreshToken: null, user: null }));
        return null;
      }
      const data = await resp.json();
      const newAccessToken = data.accessToken;
      // 更新 localStorage
      localStorage.setItem(LS_ACCESS_TOKEN, newAccessToken);
      setState(s => ({ ...s, accessToken: newAccessToken }));
      return newAccessToken;
    } catch {
      return null;
    }
  }, []);

  const loadMe = useCallback(async () => {
    const { accessToken } = loadTokens();
    if (!accessToken) {
      setState(s => ({ ...s, isLoading: false }));
      return;
    }
    try {
      const resp = await fetch('/api/auth/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!resp.ok) throw new Error('not authenticated');
      const data: AuthUser = await resp.json();
      setState(s => ({
        ...s,
        user: { id: data.id, tenantId: data.tenantId, role: data.role, username: data.username || '' },
        isAuthenticated: true,
        isLoading: false,
      }));
    } catch {
      clearTokens();
      setState({
        user: null, accessToken: null, refreshToken: null,
        isAuthenticated: false, isLoading: false,
      });
    }
  }, []);

  const value: AuthContextValue = {
    ...state,
    login,
    logout,
    refresh,
    loadMe,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** 获取当前 accessToken（供 API client 使用，不依赖 React） */
export function getAccessToken(): string | null {
  return localStorage.getItem(LS_ACCESS_TOKEN);
}

/** 获取当前 refreshToken（供 API client 使用） */
export function getRefreshToken(): string | null {
  return localStorage.getItem(LS_REFRESH_TOKEN);
}

/** 保存新的 accessToken（供 refresh 成功后使用） */
export function setAccessToken(token: string) {
  localStorage.setItem(LS_ACCESS_TOKEN, token);
}

/** 清除所有 token（refresh 失败时使用） */
export function clearAllTokens() {
  clearTokens();
}

/** 全局事件：触发跳转登录页 */
let onAuthFailure: (() => void) | null = null;
export function setOnAuthFailure(handler: (() => void) | null) {
  onAuthFailure = handler;
}
export function triggerAuthFailure() {
  clearAllTokens();
  if (onAuthFailure) onAuthFailure();
  else window.location.href = '/login';
}