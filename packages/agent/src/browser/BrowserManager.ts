/**
 * BrowserManager — Agent 浏览器管理器
 *
 * Phase 5-C-1: 封装便携版 Chrome 的启动、CDP 连接、页面管理、健康检查与关闭。
 * Phase 5-C-5 修复版：集成 ChromeProfileSanitizer、BrowserProcessRegistry、ChromeProcessGuard。
 *
 * 硬性约束：
 *   - 只连接项目内便携版 Chrome
 *   - 不连接系统正式版 Chrome
 *   - 不使用用户默认 Chrome Profile
 *   - 禁止 taskkill /IM chrome.exe
 *   - 关闭前必须校验 PID 归属
 *   - 始终只保留一个标签页
 */

import * as fs from 'fs';
import * as http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import type { BrowserConfig } from '../types';
import type { Browser, Page } from 'playwright-core';
import { sanitizeChromeProfile } from './ChromeProfileSanitizer';
import { saveSession, clearSession } from './BrowserProcessRegistry';
import { checkPort, killProcess } from './ChromeProcessGuard';

export interface BrowserHealthResult {
  connected: boolean;
  userAgent: string;
  pageUrl: string;
  title: string;
}

export class BrowserManager {
  private config: BrowserConfig;
  private chromeProcess: ChildProcess | null = null;
  private browser: Browser | null = null;
  private page: Page | null = null;

  constructor(config: BrowserConfig) {
    this.config = config;
  }

  // ══════════════════════════════════════════════════════════
  // 1. start() — 启动便携版 Chrome（含安全前置检查）
  // ══════════════════════════════════════════════════════════

  async start(): Promise<void> {
    const { executablePath, userDataDir, debugPort } = this.config;

    // 1a. 检查 chrome.exe 是否存在
    if (!fs.existsSync(executablePath)) {
      throw new Error(`未找到项目内便携版 Chrome，请检查路径：${executablePath}`);
    }

    // 1b. ChromeProcessGuard: 检查端口归属
    console.log('  [ChromeProcessGuard] 检查端口归属...');
    const portCheck = checkPort(debugPort);
    if (portCheck.occupied && !portCheck.isV3Chrome) {
      throw new Error(
        `端口 ${debugPort} 被非 V3 Chrome 占用，禁止连接。\n` +
        `  占用进程 PID: ${portCheck.pid}\n` +
        `  占用进程路径: ${portCheck.executablePath}\n` +
        `  请先关闭占用端口的 Chrome 进程后重试。`
      );
    }
    if (portCheck.occupied && portCheck.isV3Chrome) {
      console.log(`  [ChromeProcessGuard] 端口 ${debugPort} 由 V3 Chrome 占用 (PID: ${portCheck.pid})，将先关闭旧实例`);
      // 旧实例占用端口，先关闭它
      const killOld = killProcess(portCheck.pid!);
      if (killOld.success) {
        console.log(`  ${killOld.message}`);
        await new Promise((r) => setTimeout(r, 1500));
      } else {
        throw new Error(`无法关闭旧 V3 Chrome 实例: ${killOld.message}`);
      }
    } else {
      console.log(`  [ChromeProcessGuard] ${portCheck.message}`);
    }

    // 1c. ChromeProfileSanitizer: 清理 Profile 防止原生弹窗
    console.log('  [ChromeProfileSanitizer] 清理 Profile...');
    await sanitizeChromeProfile(userDataDir);

    // 1d. 创建独立用户目录
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    // 1e. 启动 Chrome（完整压制原生弹窗的启动参数，末尾不加 about:blank 避免多余标签）
    const args = [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      '--profile-directory=Default',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
      '--disable-save-password-bubble',
      '--disable-sync',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-background-networking',
      '--disable-features=Translate,PasswordManagerOnboarding,AutofillServerCommunication,AutofillAddressSavePrompt,AutofillCreditCardUpload,OptimizationHints',
      '--password-store=basic',
      '--use-mock-keychain',
    ];

    this.chromeProcess = spawn(executablePath, args, {
      stdio: 'ignore',
      detached: false,
    });

    this.chromeProcess.on('error', (err) => {
      throw new Error(`Chrome 进程启动失败：${err.message}`);
    });

    const pid = this.chromeProcess.pid;
    if (!pid) {
      throw new Error('Chrome 进程启动后无法获取 PID');
    }

    // 1f. BrowserProcessRegistry: 记录 V3 Chrome 身份
    saveSession(pid, debugPort, executablePath, userDataDir);

    console.log(`  便携版 Chrome 启动成功，PID: ${pid}`);
    console.log(`  调试端口：${debugPort}`);
    console.log(`  用户目录：${userDataDir}`);
  }

  // ══════════════════════════════════════════════════════════
  // 2. connect() — 等待 CDP 就绪、连接、清理多余标签，只保留一个
  // ══════════════════════════════════════════════════════════

  async connect(): Promise<void> {
    const { debugPort } = this.config;
    const cdp = `http://127.0.0.1:${debugPort}`;

    // 等待 CDP 就绪（最多 15 秒）
    await this.waitForCdp(cdp, 15_000);

    // 通过 Playwright connectOverCDP 连接
    const { chromium } = await import('playwright-core');
    this.browser = await chromium.connectOverCDP(cdp);
    console.log('  Playwright CDP 连接成功');

    // 清理多余标签页，只保留一个空白页
    await this.pruneToSingleTab();
  }

  /**
   * 关闭所有多余标签页，只保留一个空白标签页
   * 这确保每次启动/连接后窗口里只有一个标签
   */
  private async pruneToSingleTab(): Promise<void> {
    if (!this.browser) return;

    const context = this.browser.contexts()[0] || await this.browser.newContext();
    let pages = context.pages();

    console.log(`  当前标签页数量: ${pages.length}`);

    // 关闭所有现有页面（不能直接全部关闭，Chrome 最后一个 tab 关闭会导致窗口退出）
    // 策略：先创建一个新的空白页，再关闭其他所有页
    const keepPage = await context.newPage();
    await keepPage.goto('about:blank', { waitUntil: 'domcontentloaded' });

    for (const p of pages) {
      try {
        await p.close({ runBeforeUnload: false });
      } catch {
        // 忽略关闭错误
      }
    }

    this.page = keepPage;
    console.log('  已清理为单标签页');
  }

  private async waitForCdp(cdpUrl: string, maxWaitMs: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        const raw = await this.httpGet(`${cdpUrl}/json/version`);
        const info = JSON.parse(raw);
        console.log(`  CDP 就绪，Browser: ${info.Browser}`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error(`CDP 连接超时（${maxWaitMs}ms），请检查 Chrome 是否正常启动`);
  }

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error('请求超时'));
      });
    });
  }

  // ══════════════════════════════════════════════════════════
  // 3. getOrCreatePage() — 获取页面（确保只有一个标签）
  // ══════════════════════════════════════════════════════════

  async getOrCreatePage(): Promise<Page> {
    if (!this.browser) {
      throw new Error('浏览器未连接，请先调用 connect()');
    }
    if (!this.page) {
      const context = this.browser.contexts()[0] || await this.browser.newContext();
      this.page = await context.newPage();
    }
    return this.page;
  }

  /** 获取当前页面（不创建新页面） */
  getPage(): Page | null {
    return this.page;
  }

  /** 获取 Browser 实例 */
  getBrowser(): Browser | null {
    return this.browser;
  }

  // ══════════════════════════════════════════════════════════
  // 3b. openPage() — 在唯一标签页中导航到指定 URL
  // ══════════════════════════════════════════════════════════

  async openPage(url: string): Promise<Page> {
    if (!this.browser) {
      throw new Error('浏览器未连接，请先调用 connect()');
    }
    if (!this.page) {
      const context = this.browser.contexts()[0] || await this.browser.newContext();
      this.page = await context.newPage();
    }

    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    return this.page;
  }

  // ══════════════════════════════════════════════════════════
  // 3c. getCurrentPageInfo() — 获取当前页面信息
  // ══════════════════════════════════════════════════════════

  async getCurrentPageInfo(): Promise<{ url: string; title: string; bodyText: string }> {
    if (!this.page) {
      throw new Error('页面未初始化，请先调用 openPage() 或 getOrCreatePage()');
    }

    const url = this.page.url();
    const title = await this.page.title();
    const bodyText = await this.page.evaluate(() => {
      const body = document.body;
      return body ? body.innerText.substring(0, 500) : '';
    });

    return { url, title, bodyText };
  }

  // ══════════════════════════════════════════════════════════
  // 4. healthCheck() — 基础健康检查
  // ══════════════════════════════════════════════════════════

  async healthCheck(): Promise<BrowserHealthResult> {
    if (!this.page) {
      return { connected: false, userAgent: '', pageUrl: '', title: '' };
    }

    try {
      const userAgent = await this.page.evaluate(() => navigator.userAgent);
      const title = await this.page.evaluate(() => document.title);
      const pageUrl = this.page.url();

      return { connected: true, userAgent, pageUrl, title };
    } catch {
      return { connected: false, userAgent: '', pageUrl: '', title: '' };
    }
  }

  // ══════════════════════════════════════════════════════════
  // 5. close() — 安全关闭连接和 Chrome 进程
  // ══════════════════════════════════════════════════════════

  async close(): Promise<void> {
    const { debugPort } = this.config;

    // 5a. 通过 CDP 优雅关闭 Chrome
    // connectOverCDP 模式下 browser.close() 会发送 Browser.close CDP 命令，优雅关闭整个浏览器
    if (this.browser) {
      try {
        await this.browser.close();
        console.log('  Playwright 已发送 CDP Browser.close 命令');
      } catch {
        // 忽略关闭错误
      }
      this.browser = null;
      this.page = null;
    }

    // 5b. 等待 Chrome 优雅退出（最多 3 秒）
    console.log('  等待 Chrome 优雅退出...');
    let portClosed = false;
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const check = checkPort(debugPort);
      if (!check.occupied) {
        portClosed = true;
        break;
      }
    }

    if (portClosed) {
      console.log('  Chrome 已优雅退出，窗口已关闭');
      clearSession();
      this.chromeProcess = null;
      return;
    }

    // 5c. 优雅关闭超时，强制 kill
    console.log('  Chrome 未在预期时间内退出，强制关闭...');
    const portCheck = checkPort(debugPort);

    let pidToKill: number | null = null;
    if (portCheck.occupied && portCheck.isV3Chrome) {
      pidToKill = portCheck.pid!;
    } else if (this.chromeProcess?.pid) {
      pidToKill = this.chromeProcess.pid;
    }

    this.chromeProcess = null;

    if (!pidToKill) {
      console.log('  未找到可关闭的 Chrome 进程');
      clearSession();
      return;
    }

    if (!portCheck.isV3Chrome && portCheck.occupied) {
      console.log(`  [ChromeProcessGuard] ${portCheck.message}`);
      console.log('  拒绝关闭非 V3 Chrome');
      clearSession();
      return;
    }

    console.log(`  [ChromeProcessGuard] 强制关闭 V3 Chrome (PID: ${pidToKill})...`);
    const killResult = killProcess(pidToKill);
    if (killResult.success) {
      console.log(`  ${killResult.message}`);
    } else {
      console.warn(`  ${killResult.message}`);
    }

    // 5d. 确认端口释放
    await new Promise((r) => setTimeout(r, 1000));
    const verify = checkPort(debugPort);
    if (!verify.occupied) {
      console.log('  窗口已关闭，端口已释放');
    } else {
      console.warn(`  端口 ${debugPort} 仍被占用`);
    }

    clearSession();
  }
}
