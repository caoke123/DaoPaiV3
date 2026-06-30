/**
 * BrowserManager — Agent 浏览器管理器
 *
 * Phase 5-C-1: 封装便携版 Chrome 的启动、CDP 连接、页面管理、健康检查与关闭。
 *
 * 硬性约束：
 *   - 只连接项目内便携版 Chrome
 *   - 不连接系统正式版 Chrome
 *   - 不使用用户默认 Chrome Profile
 *   - 不登录、不执行业务、不点击按钮
 */

import * as fs from 'fs';
import * as http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import type { BrowserConfig } from '../types';
import type { Browser, Page } from 'playwright-core';

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
  // 1. start() — 启动便携版 Chrome
  // ══════════════════════════════════════════════════════════

  async start(): Promise<void> {
    const { executablePath, userDataDir, debugPort } = this.config;

    // 检查 chrome.exe 是否存在
    if (!fs.existsSync(executablePath)) {
      throw new Error(`未找到项目内便携版 Chrome，请检查路径：${executablePath}`);
    }

    // 创建独立用户目录
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
    }

    // 启动 Chrome
    const args = [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-extensions',
      'about:blank',
    ];

    this.chromeProcess = spawn(executablePath, args, {
      stdio: 'ignore',
      detached: false,
    });

    this.chromeProcess.on('error', (err) => {
      throw new Error(`Chrome 进程启动失败：${err.message}`);
    });

    console.log(`  便携版 Chrome 启动成功，PID: ${this.chromeProcess.pid}`);
    console.log(`  调试端口：${debugPort}`);
    console.log(`  用户目录：${userDataDir}`);
  }

  // ══════════════════════════════════════════════════════════
  // 2. connect() — 等待 CDP 就绪并连接
  // ══════════════════════════════════════════════════════════

  async connect(): Promise<void> {
    const { debugPort } = this.config;
    const cdp = `http://127.0.0.1:${debugPort}`;

    // 等待 CDP 就绪（最多 10 秒）
    await this.waitForCdp(cdp, 10_000);

    // 通过 Playwright connectOverCDP 连接
    const { chromium } = await import('playwright-core');
    this.browser = await chromium.connectOverCDP(cdp);
    console.log('  Playwright CDP 连接成功');
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
  // 3. getOrCreatePage() — 获取或创建页面
  // ══════════════════════════════════════════════════════════

  async getOrCreatePage(): Promise<Page> {
    if (!this.browser) {
      throw new Error('浏览器未连接，请先调用 connect()');
    }

    const context = this.browser.contexts()[0] || this.browser.newContext();
    const pages = context.pages();
    this.page = pages.length > 0 ? pages[0] : await context.newPage();

    // 默认打开 about:blank
    await this.page.goto('about:blank', { waitUntil: 'domcontentloaded' });

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
  // 5. close() — 关闭连接和 Chrome 进程
  // ══════════════════════════════════════════════════════════

  async close(): Promise<void> {
    // 关闭 Playwright CDP 连接
    if (this.browser) {
      try {
        await this.browser.close();
        console.log('  Playwright 连接已关闭');
      } catch {
        // 忽略关闭错误
      }
      this.browser = null;
      this.page = null;
    }

    // 关闭 Chrome 进程
    if (this.chromeProcess) {
      try {
        this.chromeProcess.kill();
        console.log('  Chrome 进程已关闭');
      } catch {
        console.warn('  无法优雅关闭 Chrome 进程，请手动检查任务管理器');
      }
      this.chromeProcess = null;
    }
  }
}