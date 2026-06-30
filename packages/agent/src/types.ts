/**
 * DaoPai Agent 类型定义
 */

/** Agent 配置 */
export interface AgentConfig {
  /** Cloud 后端地址 */
  cloudBaseUrl: string;
  /** 执行电脑授权码（明文） */
  agentToken: string;
  /** 执行电脑名称 */
  workstationName: string;
  /** 所属网点编号（可空） */
  siteId: string | null;
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