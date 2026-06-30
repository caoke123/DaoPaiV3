/**
 * testBnsySessionP0.ts — 笨鸟登录状态保持与 Dashboard P0 检测
 *
 * Phase 5-C-5: 检测当前登录状态，复用已有登录态，
 * 未登录时自动登录，然后验证 Dashboard P0 是否就绪。
 *
 * 硬性约束：
 *   - 不打印密码
 *   - 不执行业务
 *   - 不点击业务菜单
 */

import { BrowserManager } from './browser/BrowserManager';
import { ensureBnsyLoggedIn } from './browser/BnsySessionManager';
import { AgentSettingsLoader } from './AgentSettingsLoader';

function maskAccount(account: string): string {
  if (account.length <= 4) return '****';
  return account.substring(0, 2) + '****' + account.substring(account.length - 2);
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  DaoPai V3 登录状态与 Dashboard P0 检测');
  console.log('  Phase 5-C-5');
  console.log('═══════════════════════════════════════════\n');

  // ── 配置 ──
  const siteId = 'site-1782121346155'; // 天南大
  const loginUrl = 'https://bnsy.benniaosuyun.com/login';

  const browserConfig = {
    executablePath: 'E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe',
    userDataDir: 'E:/网站开发/DaoPaiV3/runtime/chrome-profile',
    debugPort: 9223,
    headless: false,
  };

  // ── 1. 读取凭据 ──
  console.log('[1/5] 读取员工凭据...');
  const settingsLoader = new AgentSettingsLoader();
  const credential = await settingsLoader.getLoginCredentialForSite(siteId);

  if (!credential) {
    console.error('  错误：无法读取员工凭据，请检查 settings.json');
    process.exit(1);
  }

  console.log(`  网点：${credential.siteName}`);
  console.log(`  员工：${credential.employeeName}`);
  console.log(`  账号：${maskAccount(credential.loginAccount)}`);
  console.log('');

  // ── 2. 启动浏览器 ──
  console.log('[2/5] 启动便携版 Chrome...');
  const manager = new BrowserManager(browserConfig);
  await manager.start();
  console.log('  便携版 Chrome 启动成功\n');

  // ── 3. CDP 连接 ──
  console.log('[3/5] 等待 CDP 就绪并连接...');
  await manager.connect();
  console.log('  CDP 连接成功\n');

  // ── 4. 打开登录页 ──
  console.log('[4/5] 打开页面并检测登录状态...');
  console.log(`  正在打开：${loginUrl}`);

  let page;
  try {
    page = await manager.openPage(loginUrl);
  } catch (err) {
    console.error(`  页面打开失败：${(err as Error).message}`);
    await manager.close().catch(() => {});
    process.exit(1);
  }

  console.log('  页面打开成功');
  console.log('  正在检测登录状态...\n');

  // ── 5. 确保登录 + Dashboard P0 检测 ──
  const result = await ensureBnsyLoggedIn(page, credential);

  // ── 输出报告 ──
  console.log('  ── 登录状态 ──');
  console.log(`  是否复用登录态：${result.reusedSession ? '是' : '否'}`);
  console.log(`  是否执行登录：${result.loginAttempted ? '是' : '否'}`);
  console.log(`  结果：${result.success ? '成功' : '失败'}`);
  console.log(`  说明：${result.message}`);
  console.log('');

  const d = result.dashboard;
  console.log('  ── Dashboard P0 ──');
  console.log(`  状态：${d.status}`);
  console.log(`  当前 URL：${d.url}`);
  console.log(`  页面标题：${d.title || '(空)'}`);
  console.log(`  已登录：${d.isLoggedIn ? '是' : '否'}`);
  console.log(`  是 Dashboard：${d.isDashboard ? '是' : '否'}`);
  console.log(`  核心 DOM：${d.hasCoreDom ? '已检测到' : '未检测到'}`);
  if (d.coreSelectorsMatched.length > 0) {
    console.log(`    选择器：${d.coreSelectorsMatched.join(', ')}`);
  }
  console.log(`  阻塞弹窗：${d.hasBlockedPopup ? '已检测到' : '未检测到'}`);
  if (d.popupSelectorsMatched.length > 0) {
    console.log(`    选择器：${d.popupSelectorsMatched.join(', ')}`);
  }
  console.log('');

  if (result.warnings.length > 0) {
    console.log('  ── 警告 ──');
    for (const w of result.warnings) {
      console.log(`  - ${w}`);
    }
    console.log('');
  }

  console.log('  ── 安全边界 ──');
  console.log('  未点击业务菜单');
  console.log('  未点击业务按钮');
  console.log('  未执行到件扫描');
  console.log('  未处理运单');
  console.log('  未打印密码');
  console.log('  未上传密码');
  console.log('');

  // ── 6. 关闭 ──
  console.log('[5/5] 关闭浏览器...');
  await manager.close();
  console.log('  检测完成，浏览器已关闭\n');

  console.log('═══════════════════════════════════════════');
  console.log('  登录状态与 Dashboard P0 检测完成');
  console.log('═══════════════════════════════════════════');
  console.log(`  网点：${credential.siteName}`);
  console.log(`  员工：${credential.employeeName}`);
  console.log(`  账号：${maskAccount(credential.loginAccount)}`);
  console.log(`  P0 状态：${d.status}`);
  console.log(`  结果：${result.success ? '通过' : '未通过'}`);
  console.log('═══════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('\n检测失败：', err.message);
  process.exit(1);
});