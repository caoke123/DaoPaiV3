/**
 * ChromeProcessGuard — Chrome 进程守卫
 *
 * Phase 5-C-5 修复版：防止误连接或误关闭非 V3 Chrome。
 *
 * 职责：
 *   1. 检查 debugPort 是否被占用
 *   2. 识别占用端口的 PID
 *   3. 校验 PID 是否是 V3 Chrome（通过 executablePath + userDataDir）
 *   4. 非 V3 Chrome 占用端口时，禁止连接并报错
 *   5. close 时校验 PID，确认后才允许关闭
 */

import { execSync } from 'child_process';

export interface PortCheckResult {
  occupied: boolean;
  pid: number | null;
  isV3Chrome: boolean;
  executablePath: string;
  commandLine: string;
  message: string;
}

const EXPECTED_CHROME_PATH = 'E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe';
const EXPECTED_USER_DATA_DIR = 'E:/网站开发/DaoPaiV3/runtime/chrome-profile';

/**
 * 检查 debugPort 的归属
 */
export function checkPort(debugPort: number): PortCheckResult {
  const result: PortCheckResult = {
    occupied: false,
    pid: null,
    isV3Chrome: false,
    executablePath: '',
    commandLine: '',
    message: '',
  };

  try {
    // 使用 PowerShell 获取占用端口的 PID
    const psCmd = `Get-NetTCPConnection -LocalPort ${debugPort} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`;
    const output = execSync(`powershell -NoProfile -Command "${psCmd}"`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    if (!output) {
      result.message = `端口 ${debugPort} 未被占用`;
      return result;
    }

    const pid = parseInt(output);
    if (isNaN(pid) || pid <= 0) {
      result.message = `端口 ${debugPort} 占用信息无法解析`;
      return result;
    }

    result.occupied = true;
    result.pid = pid;

    // 获取进程详细信息
    const processInfo = getProcessInfo(pid);
    result.executablePath = processInfo.executablePath;
    result.commandLine = processInfo.commandLine;

    // 校验是否 V3 Chrome
    result.isV3Chrome = isV3ChromeProcess(processInfo);
    if (result.isV3Chrome) {
      result.message = `端口 ${debugPort} 由 V3 Chrome 占用 (PID: ${pid})`;
    } else {
      result.message = `端口 ${debugPort} 被非 V3 Chrome 占用 (PID: ${pid}, 路径: ${processInfo.executablePath})`;
    }

    return result;
  } catch (err) {
    result.message = `端口检查失败: ${(err as Error).message}`;
    return result;
  }
}

interface ProcessInfo {
  executablePath: string;
  commandLine: string;
}

function getProcessInfo(pid: number): ProcessInfo {
  const result: ProcessInfo = { executablePath: '', commandLine: '' };

  try {
    const psCmd = `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
    const output = execSync(`powershell -NoProfile -Command "${psCmd}"`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    if (output) {
      try {
        const info = JSON.parse(output);
        result.executablePath = (info.ExecutablePath || '').replace(/\\/g, '/');
        result.commandLine = info.CommandLine || '';
      } catch {
        // JSON 解析失败，忽略
      }
    }
  } catch {
    // PowerShell 查询失败，忽略
  }

  return result;
}

function isV3ChromeProcess(info: ProcessInfo): boolean {
  const normalizedPath = info.executablePath.replace(/\\/g, '/');
  const expectedPath = EXPECTED_CHROME_PATH.replace(/\\/g, '/');

  // 1. executablePath 必须匹配
  if (normalizedPath !== expectedPath) {
    return false;
  }

  // 2. CommandLine 必须包含 V3 userDataDir
  if (!info.commandLine.includes(EXPECTED_USER_DATA_DIR)) {
    return false;
  }

  return true;
}

/**
 * 检查进程是否仍然存活
 */
function isProcessAlive(pid: number): boolean {
  try {
    const psCmd = `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`;
    const output = execSync(`powershell -NoProfile -Command "${psCmd}"`, {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    return output === String(pid);
  } catch {
    return false;
  }
}

/**
 * 校验给定的 PID 是否能被关闭（必须是 V3 Chrome）
 */
export function canKillProcess(pid: number): { allowed: boolean; message: string } {
  // 先检查进程是否还存在
  if (!isProcessAlive(pid)) {
    return { allowed: true, message: `PID ${pid} 进程已不存在（已自然退出），无需关闭` };
  }

  const info = getProcessInfo(pid);

  if (!info.executablePath) {
    return {
      allowed: false,
      message: `无法获取 PID ${pid} 的进程信息，拒绝关闭`,
    };
  }

  if (!isV3ChromeProcess(info)) {
    return {
      allowed: false,
      message: `PID ${pid} 不是 V3 Chrome (路径: ${info.executablePath})，拒绝关闭，防止误关系统正式版 Chrome`,
    };
  }

  return {
    allowed: true,
    message: `PID ${pid} 确认为 V3 Chrome，允许关闭`,
  };
}

/**
 * 通过 PID 关闭 Chrome 进程
 */
export function killProcess(pid: number): { success: boolean; message: string } {
  try {
    execSync(`taskkill /PID ${pid} /T /F`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return { success: true, message: `已关闭 V3 Chrome 进程 (PID: ${pid})` };
  } catch (err) {
    return { success: false, message: `关闭进程失败 (PID: ${pid}): ${(err as Error).message}` };
  }
}