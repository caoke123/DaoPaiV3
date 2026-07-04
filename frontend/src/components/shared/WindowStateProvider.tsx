// WindowStateProvider — 统一窗口状态管理（D-0B: EasyBR legacy removed）
// 替代 Header、ScanWorkbench、StatusBar 各自的独立轮询
// 单一真理源：V3 Playwright 路径，5s 轮询
import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import {
  getSettingsConfig,
  getSitePlaywrightWindows,
  getCloudWindowStatus,
  getWindowRuntimeMode,
  getRuntimeStatus,
  type SiteConfig,
  type PlaywrightSiteWindowState,
  type CloudWindowStatus,
  type WindowRuntimeMode,
  type BrowserRuntimeStatus,
} from '../../api/client';

export interface WindowStateContextValue {
  // 配置
  sites: SiteConfig[];
  activeSiteId: string;
  setActiveSiteId: (id: string) => void;

  // runtimeMode（D-0B: default playwright）
  runtimeMode: WindowRuntimeMode;
  isPlaywright: boolean;

  // 本地浏览器运行时状态
  browserRuntimeStatus: BrowserRuntimeStatus;
  browserRuntimeError: string | null;

  // 窗口数据（playwright 模式下含 p0Passed/pageCount 等诊断字段）
  siteWindows: PlaywrightSiteWindowState[];
  siteName: string;

  // 手动刷新
  refresh: () => void;

  // 派生：用于 StatusBar
  connectedCount: number;   // ready + busy 的窗口数
  windowCount: number;     // 窗口总数
  allReady: boolean;       // 全部 ready

  // 错误
  configError: boolean;
  fetchError: string;
}

const WindowStateContext = createContext<WindowStateContextValue | null>(null);

export function useWindowState(): WindowStateContextValue {
  const ctx = useContext(WindowStateContext);
  if (!ctx) throw new Error('useWindowState 必须用在 <WindowStateProvider> 内');
  return ctx;
}

export function WindowStateProvider({ children }: { children: ReactNode }) {
  const [sites, setSites] = useState<SiteConfig[]>([]);
  const [activeSiteId, setActiveSiteId] = useState<string>('');
  const [runtimeMode, setRuntimeMode] = useState<WindowRuntimeMode>('playwright');
  const [siteWindows, setSiteWindows] = useState<PlaywrightSiteWindowState[]>([]);
  const [siteName, setSiteName] = useState('');
  const [configError, setConfigError] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [browserRuntimeStatus, setBrowserRuntimeStatus] = useState<BrowserRuntimeStatus>('unavailable');
  const [browserRuntimeError, setBrowserRuntimeError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 0. 加载 runtimeMode（页面加载时获取一次；后端 .env 切换后需刷新页面）
  const loadRuntimeMode = useCallback(async () => {
    try {
      const res = await getWindowRuntimeMode();
      setRuntimeMode(res.runtimeMode);
      console.log(`[WindowStateProvider] runtimeMode=${res.runtimeMode}`);
    } catch (e) {
      // D-0B: EasyBR removed, default to playwright
      setRuntimeMode('playwright');
      console.warn('[WindowStateProvider] 获取 runtimeMode 失败，回退 playwright:', (e as Error).message);
    }
  }, []);

  // 1. 加载配置
  const loadConfig = useCallback(async () => {
    try {
      const res = await getSettingsConfig();
      setSites(res.sites);
      setConfigError(false);
      if (res.sites.length > 0) {
        setActiveSiteId(prev =>
          prev && res.sites.find(s => s.id === prev) ? prev : res.sites[0].id,
        );
      } else {
        setActiveSiteId('');
      }
      return res.sites;
    } catch {
      setConfigError(true);
      return null;
    }
  }, []);

  useEffect(() => {
    loadRuntimeMode();
    loadConfig();
  }, [loadRuntimeMode, loadConfig]);

  // 0.5. 轮询本地浏览器运行时状态（30s 间隔）
  useEffect(() => {
    const fetchRuntime = async () => {
      try {
        const status = await getRuntimeStatus();
        setBrowserRuntimeStatus(status.runtime);
        setBrowserRuntimeError(status.runtimeError);
      } catch {
        // 静默失败，保持上次状态
      }
    };
    fetchRuntime();
    const timer = setInterval(fetchRuntime, 30_000);
    return () => clearInterval(timer);
  }, []);

  // 2. 轮询（5s）— D-0C: 优先 Cloud Agent 上报状态，Playwright fallback
  const fetchSiteWindows = useCallback(async () => {
    if (!activeSiteId) return;
    try {
      // D-0C: 优先读取 Cloud persistent window_status
      const cloudData = await getCloudWindowStatus(activeSiteId).catch(() => null);
      if (cloudData && cloudData.windows.length > 0) {
        // Map cloud status to playwright-compatible format
        setSiteWindows(cloudData.windows.map((w: CloudWindowStatus) => ({
          windowId: w.windowId,
          staffName: w.staffName,
          runtimeKey: `${w.siteId}-${w.workstationId}-${w.windowId}`,
          status: w.status,
          p0Passed: w.isDashboardReady,
          pageCount: w.isDashboardReady ? 1 : 0,
          currentUrl: w.currentUrl || '',
          tenantId: (w as any).tenantId || '',
          siteId: w.siteId,
          siteName: '',
          windowName: w.windowId,
          employeeName: w.staffName,
          browserId: null,
          p0Check: { required: true },
          cachedStatus: null,
          lastStatusCheckAt: null,
        } as unknown as PlaywrightSiteWindowState)));
        setSiteName('');
        setFetchError('');
        return;
      }
      // Fallback: Playwright 过渡路径
      const data = await getSitePlaywrightWindows(activeSiteId);
      setSiteWindows(data.windows);
      setSiteName(data.siteName);
      setFetchError('');
    } catch (e) {
      setFetchError('无法连接到后端服务');
    }
  }, [activeSiteId]);

  useEffect(() => {
    fetchSiteWindows();
    pollRef.current = setInterval(fetchSiteWindows, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchSiteWindows]);

  // 3. 派生数据（用于 StatusBar）
  const readyCount = siteWindows.filter(w => w.status === 'ready').length;
  const busyCount = siteWindows.filter(w => w.status === 'busy').length;
  const connectingCount = siteWindows.filter(w => w.status === 'connecting' || w.status === 'connected').length;
  const connectedCount = readyCount + busyCount + connectingCount;
  const windowCount = siteWindows.length;
  const allReady = windowCount > 0 && readyCount === windowCount;

  const refresh = useCallback(async () => {
    await loadRuntimeMode();
    await loadConfig();
    await fetchSiteWindows();
  }, [loadRuntimeMode, loadConfig, fetchSiteWindows]);

  const value: WindowStateContextValue = {
    sites,
    activeSiteId,
    setActiveSiteId,
    runtimeMode,
    isPlaywright: runtimeMode === 'playwright',
    browserRuntimeStatus,
    browserRuntimeError,
    siteWindows,
    siteName,
    refresh,
    connectedCount,
    windowCount,
    allReady,
    configError,
    fetchError,
  };

  return (
    <WindowStateContext.Provider value={value}>
      {children}
    </WindowStateContext.Provider>
  );
}
