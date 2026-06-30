/**
 * BrowserProcessRegistry — Chrome 进程注册表
 *
 * Phase 5-C-5 修复版：记录 V3 本次启动的 Chrome 身份信息，
 * 用于关闭时精确校验，防止误关系统正式版 Chrome。
 *
 * 写入 runtime/browser-session.json，字段：
 *   - instanceId: V3 Agent 实例标识
 *   - pid: Chrome 进程 ID
 *   - debugPort: CDP 调试端口
 *   - executablePath: Chrome 可执行文件路径
 *   - userDataDir: 用户数据目录
 *   - startedAt: 启动时间
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface SessionRecord {
  instanceId: string;
  pid: number;
  debugPort: number;
  executablePath: string;
  userDataDir: string;
  startedAt: string;
}

const SESSION_FILE = path.resolve(
  __dirname, '..', '..', '..', '..', 'runtime', 'browser-session.json',
);

function generateInstanceId(): string {
  return `v3-agent-${crypto.randomBytes(4).toString('hex')}`;
}

export function saveSession(
  pid: number,
  debugPort: number,
  executablePath: string,
  userDataDir: string,
): SessionRecord {
  // 确保 runtime 目录存在
  const runtimeDir = path.dirname(SESSION_FILE);
  if (!fs.existsSync(runtimeDir)) {
    fs.mkdirSync(runtimeDir, { recursive: true });
  }

  const record: SessionRecord = {
    instanceId: generateInstanceId(),
    pid,
    debugPort,
    executablePath,
    userDataDir,
    startedAt: new Date().toISOString(),
  };

  fs.writeFileSync(SESSION_FILE, JSON.stringify(record, null, 2), 'utf-8');
  console.log(`  [BrowserProcessRegistry] 已记录 V3 Chrome 会话: PID=${pid}, 端口=${debugPort}`);
  return record;
}

export function readSession(): SessionRecord | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const raw = fs.readFileSync(SESSION_FILE, 'utf-8');
    return JSON.parse(raw) as SessionRecord;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE);
    }
  } catch {
    // 忽略清理失败
  }
}