/**
 * AgentSettingsLoader — 最小化 settings.json 读取器
 *
 * Phase 5-B: 只读取 siteName / dryRunMode，不读取员工账号密码和窗口绑定。
 * Phase 5-C-4: 新增 getLoginCredentialForSite()，读取当前网点一个员工账号密码。
 *
 * settingsPath 优先级（从高到低）：
 *   1. 环境变量 DAOPAI_SETTINGS_PATH
 *   2. agent.json 中 settingsPath 字段
 *   3. 默认路径：../../data/settings.json（从 packages/agent/ 向上两级到项目根目录）
 */

import * as fs from 'fs';
import * as path from 'path';

interface WindowEntry {
  windowName?: string;
  employeeName?: string;
  username?: string;
  password?: string;
  easybrBrowserId?: string;
}

interface SettingsData {
  initialized?: boolean;
  runtime?: {
    dryRunMode?: boolean;
  };
  sites?: Array<{
    id: string;
    name: string;
    windows?: WindowEntry[];
  }>;
}

export interface LoginCredential {
  siteId: string;
  siteName: string;
  employeeName: string;
  loginAccount: string;
  loginPassword: string;
}

/**
 * 解析 settingsPath
 */
export function resolveSettingsPath(agentSettingsPath?: string): string {
  // 1. 环境变量优先
  const envPath = process.env.DAOPAI_SETTINGS_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  // 2. agent.json 中 settingsPath
  if (agentSettingsPath) {
    const resolved = path.resolve(process.cwd(), agentSettingsPath);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }

  // 3. 默认路径
  const defaultPath = path.resolve(process.cwd(), '..', '..', 'data', 'settings.json');
  return defaultPath;
}

export class AgentSettingsLoader {
  private settingsPath: string;
  private cache: SettingsData | null = null;
  private cacheTime = 0;
  private readonly CACHE_TTL_MS = 30_000; // 30 秒缓存

  constructor(settingsPath?: string) {
    this.settingsPath = resolveSettingsPath(settingsPath);
  }

  /** 读取 settings.json（带缓存） */
  private async loadSettings(): Promise<SettingsData | null> {
    const now = Date.now();
    if (this.cache && now - this.cacheTime < this.CACHE_TTL_MS) {
      return this.cache;
    }

    try {
      if (!fs.existsSync(this.settingsPath)) {
        console.warn(`[AgentSettingsLoader] settings.json 不存在: ${this.settingsPath}`);
        return null;
      }
      const raw = fs.readFileSync(this.settingsPath, 'utf-8');
      this.cache = JSON.parse(raw) as SettingsData;
      this.cacheTime = now;
      return this.cache;
    } catch (err) {
      console.warn(`[AgentSettingsLoader] 读取 settings.json 失败: ${(err as Error).message}`);
      return null;
    }
  }

  /** 根据 siteId 查找网点配置，校验是否存在 */
  async getSiteById(siteId: string): Promise<{ id: string; name: string } | null> {
    const data = await this.loadSettings();
    if (!data?.sites) return null;
    const site = data.sites.find(s => s.id === siteId);
    return site ? { id: site.id, name: site.name } : null;
  }

  /** 根据 siteId 返回网点名称 */
  async getSiteName(siteId: string): Promise<string> {
    const site = await this.getSiteById(siteId);
    return site?.name || siteId;
  }

  /** 读取全局试运行开关 */
  async getDryRunMode(): Promise<boolean> {
    const data = await this.loadSettings();
    if (!data?.initialized) return true;
    return data.runtime?.dryRunMode !== false;
  }

  /**
   * 获取当前网点的一个可用员工登录凭据
   *
   * Phase 5-C-4: 只读取当前 siteId 下第一个有密码的窗口。
   * 密码在 settings.json 中为 base64 编码，读取时解码。
   * 不读取 credentials.ts，不上传 Cloud，不打印密码。
   *
   * @param siteId 网点编号
   * @returns 登录凭据，找不到时返回 null
   */
  async getLoginCredentialForSite(siteId: string): Promise<LoginCredential | null> {
    const data = await this.loadSettings();
    if (!data?.sites) {
      console.error('[AgentSettingsLoader] 错误：settings.json 中未找到网点配置');
      return null;
    }

    const site = data.sites.find(s => s.id === siteId);
    if (!site) {
      console.error(`[AgentSettingsLoader] 错误：未找到网点 ${siteId}，请检查 settings.json`);
      return null;
    }

    if (!site.windows || site.windows.length === 0) {
      console.error(`[AgentSettingsLoader] 错误：网点 ${site.name} 下没有配置窗口，请检查 settings.json`);
      return null;
    }

    // 找到第一个有 username 和 password 的窗口
    const win = site.windows.find(w => w.username && w.password);
    if (!win) {
      console.error(`[AgentSettingsLoader] 错误：网点 ${site.name} 下没有找到可用员工凭据`);
      return null;
    }

    // 解码 base64 密码
    let decodedPassword = '';
    try {
      decodedPassword = Buffer.from(win.password!, 'base64').toString('utf-8');
    } catch {
      console.error(`[AgentSettingsLoader] 错误：员工 ${win.employeeName || win.username} 密码解码失败`);
      return null;
    }

    if (!decodedPassword) {
      console.error(`[AgentSettingsLoader] 错误：员工 ${win.employeeName || win.username} 密码为空`);
      return null;
    }

    return {
      siteId: site.id,
      siteName: site.name,
      employeeName: win.employeeName || win.username || '未知员工',
      loginAccount: win.username!,
      loginPassword: decodedPassword,
    };
  }
}