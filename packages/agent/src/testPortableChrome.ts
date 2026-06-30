/**
 * testPortableChrome.ts — 便携版 Chrome 连接测试
 *
 * Phase 5-C-0: 测试项目内便携版 Chrome 是否可被 Agent 启动和连接。
 *
 * 硬性约束：
 *   - 只连接项目内便携版 Chrome（E:\网站开发\DaoPaiV3\Chrome\App\chrome.exe）
 *   - 不连接系统正式版 Chrome
 *   - 不使用用户默认 Chrome Profile
 *   - 不执行真实业务任务
 */

import * as path from 'path';
import * as fs from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import * as http from 'http';

// ── 配置 ──────────────────────────────────────────────────

const CHROME_EXE = path.resolve(__dirname, '..', '..', '..', 'Chrome', 'App', 'chrome.exe');
const DEBUG_PORT = 9223;
const USER_DATA_DIR = path.resolve(__dirname, '..', '..', '..', 'runtime', 'chrome-profile-test');
const CDP_BASE = `http://127.0.0.1:${DEBUG_PORT}`;
const MAX_WAIT_MS = 10_000;

// ── 工具函数 ──────────────────────────────────────────────

function httpGet(url: string): Promise<string> {
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

async function waitForCdp(maxWaitMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const raw = await httpGet(`${CDP_BASE}/json/version`);
      const info = JSON.parse(raw);
      console.log(`CDP 连接成功，Browser: ${info.Browser}`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`CDP 连接超时（${maxWaitMs}ms），请检查 Chrome 是否正常启动`);
}

// ── 主流程 ────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  DaoPai V3 便携版 Chrome 连接测试');
  console.log('  Phase 5-C-0');
  console.log('═══════════════════════════════════════════\n');

  // 1. 检查 chrome.exe 是否存在
  console.log('[1/6] 检查便携版 Chrome...');
  if (!fs.existsSync(CHROME_EXE)) {
    console.error(`\n未找到项目内便携版 Chrome，请检查路径：${CHROME_EXE}\n`);
    process.exit(1);
  }
  console.log(`  便携版 Chrome 路径检查通过：${CHROME_EXE}`);

  // 2. 创建独立用户目录
  console.log('\n[2/6] 创建用户数据目录...');
  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    console.log(`  已创建：${USER_DATA_DIR}`);
  } else {
    console.log(`  目录已存在：${USER_DATA_DIR}`);
  }

  // 3. 启动便携版 Chrome
  console.log('\n[3/6] 启动便携版 Chrome...');
  const chromeArgs = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    'about:blank',
  ];

  let chromeProcess: ChildProcess | null = null;
  try {
    chromeProcess = spawn(CHROME_EXE, chromeArgs, {
      stdio: 'ignore',
      detached: false,
    });

    chromeProcess.on('error', (err) => {
      console.error(`  Chrome 启动失败：${err.message}`);
    });

    console.log(`  Chrome 进程启动成功，PID: ${chromeProcess.pid}`);
    console.log(`  调试端口：${DEBUG_PORT}`);
    console.log(`  用户目录：${USER_DATA_DIR}`);
  } catch (err) {
    console.error(`  Chrome 启动失败：${(err as Error).message}`);
    process.exit(1);
  }

  // 4. 等待 CDP 可连接
  console.log('\n[4/6] 等待 CDP 就绪...');
  try {
    await waitForCdp(MAX_WAIT_MS);
  } catch (err) {
    console.error(`  ${(err as Error).message}`);
    if (chromeProcess) chromeProcess.kill();
    process.exit(1);
  }

  // 5. 使用 Playwright connectOverCDP 连接
  console.log('\n[5/6] 通过 Playwright connectOverCDP 连接...');
  try {
    // 动态导入 playwright-core（避免在非测试环境必须安装）
    const { chromium } = await import('playwright-core');

    const browser = await chromium.connectOverCDP(CDP_BASE);
    console.log('  Playwright connectOverCDP 成功');

    const context = browser.contexts()[0] || browser.newContext();
    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();

    // 6. 打开 about:blank 并执行简单 JS
    console.log('\n[6/6] 执行页面测试...');
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });

    const userAgent = await page.evaluate(() => navigator.userAgent);
    const title = await page.evaluate(() => document.title);

    console.log(`  UserAgent: ${userAgent}`);
    console.log(`  页面标题: "${title}"`);

    // 关闭 CDP 连接
    await browser.close();
    console.log('\n  Playwright 连接已关闭');
  } catch (err) {
    console.error(`  Playwright 连接失败：${(err as Error).message}`);
    console.error('  请确认已安装 playwright-core：npm install playwright-core --save');
    if (chromeProcess) chromeProcess.kill();
    process.exit(1);
  }

  // 7. 关闭 Chrome 进程
  console.log('\n关闭 Chrome 进程...');
  if (chromeProcess) {
    try {
      chromeProcess.kill();
      console.log('  Chrome 进程已关闭');
    } catch {
      console.warn('  无法优雅关闭 Chrome 进程，请手动检查任务管理器');
    }
  }

  // ── 最终报告 ──
  console.log('\n═══════════════════════════════════════════');
  console.log('  便携版 Chrome 连接测试完成');
  console.log('═══════════════════════════════════════════');
  console.log(`  Chrome 路径：${CHROME_EXE}`);
  console.log(`  调试端口：${DEBUG_PORT}`);
  console.log(`  用户目录：${USER_DATA_DIR}`);
  console.log('  测试结果：通过');
  console.log('═══════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('\n测试失败：', err.message);
  process.exit(1);
});