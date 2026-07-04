/**
 * DaoPai Agent 类型定义
 */

/** 浏览器配置 */
export interface BrowserConfig {
  /** 便携版 Chrome 可执行文件路径（必填） */
  executablePath: string;
  /** 独立用户数据目录（必填） */
  userDataDir: string;
  /** CDP 调试端口，默认 9223 */
  debugPort: number;
  /** 无头模式（当前 Windows 便携版默认 false） */
  headless: boolean;
}

/** 笨鸟系统配置 */
export interface BnsyConfig {
  /** 笨鸟登录页地址 */
  loginUrl: string;
}

/** Agent 配置 */
export interface AgentConfig {
  /** Cloud 后端地址 */
  cloudBaseUrl: string;
  /** Cloud 后端地址别名（配置样例兼容 V3 原始文档命名） */
  cloudApiUrl?: string;
  /** 租户编号（用于本地日志/配置展示，鉴权仍以 Agent Token 为准） */
  tenantId?: string;
  /** 执行电脑编号（用于本地日志/配置展示，鉴权仍以 Agent Token 为准） */
  workstationId?: string;
  /** 执行电脑授权码（明文） */
  agentToken: string;
  /** 执行电脑名称 */
  workstationName: string;
  /** 所属网点编号（可空） */
  siteId: string | null;
  /** settings.json 路径（可空，默认 ../../data/settings.json） */
  settingsPath?: string;
  /** 浏览器配置 */
  browser: BrowserConfig;
  /** 笨鸟系统配置 */
  bnsy?: BnsyConfig;
  /** 日志级别 */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** 心跳间隔（毫秒） */
  heartbeatIntervalMs: number;
  /** 任务轮询间隔（毫秒） */
  taskPollIntervalMs: number;
}

/** 心跳请求体 */
export interface HeartbeatRequest {
  agentVersion: string;
  machineFingerprint: string;
  browserStatus: 'ready' | 'login' | 'p0' | 'unknown';
  localStatus: {
    runningTaskId: string | null;
    pendingLogCount: number;
    diskFreeMb: number;
  };
}

/** 心跳响应 */
export interface HeartbeatResponse {
  serverTime: string;
  workstationStatus: string;
  hasTask: boolean;
  nextPollAfterMs: number;
}

/** /agent/me 响应 */
export interface AgentMeResponse {
  workstationId: string;
  name: string;
  tenantId: string;
  tenantName: string;
  siteId: string | null;
  siteName: string | null;
  status: string;
  onlineStatus: string;
  browserStatus: string;
}

/** Agent 鉴权失败响应 */
export interface AgentErrorResponse {
  ok: false;
  code: string;
  message: string;
  timestamp: string;
}
