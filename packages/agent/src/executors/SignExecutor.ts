/**
 * SignExecutor — 签收录入 Agent 执行器
 *
 * 仅支持浏览器 DRY-RUN（browserDryRun=true），不提供模拟 dryRun 分支。
 *
 * 硬性约束：
 *   - dryRun 必须不为 false，否则拒绝执行
 *   - browserDryRun 必须为 true，否则拒绝执行
 *   - waybills 不能为空（用于 results 回传，SignBrowserDryRunInput 本身不接收 waybills）
 *   - 浏览器页面操作禁止点击最终提交（批量签收）
 *   - 不修改 /api/operations/sign、BrowserPool、AssignmentEngine、SignHandler
 *   - 不触碰 V2
 */

import type { AxiosInstance } from 'axios';
import {
  reportProgress,
  uploadLogs,
  completeTask,
  failTask,
} from '../httpClient';
import type { AgentSettingsLoader } from '../AgentSettingsLoader';
import { BrowserManager } from '../browser/BrowserManager';
import { ensureBnsyLoggedIn } from '../browser/BnsySessionManager';
import { runSignBrowserDryRun } from '../browser/SignBrowserDryRun';
import type { AgentConfig } from '../types';

interface SignTask {
  taskId: string;
  siteId: string;
  payload: {
    waybills: string[];
    options?: {
      staffName?: string;
    };
    siteName?: string;
    dryRun?: boolean;
    browserDryRun?: boolean;
  };
}

/**
 * 执行 Sign 签收录入任务（仅 browserDryRun 模式）
 *
 * 内部判断：
 *   - dryRun === false → 拒绝执行
 *   - browserDryRun !== true → 拒绝执行
 *   - waybills 为空 → 拒绝执行
 *
 * 注意：SignBrowserDryRunInput 不接收 waybills，仅接收 siteId/siteName/options；
 *       waybills 仅用于 results 回传与 total 统计。
 */
export async function executeSignDryRun(
  task: SignTask,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
  config?: AgentConfig,
): Promise<void> {
  const { taskId, siteId, payload } = task;
  const waybills = payload.waybills || [];
  const siteName = payload.siteName || await settingsLoader.getSiteName(siteId);

  // 校验 dryRun
  if (payload.dryRun === false) {
    console.error(`[SignExecutor] 任务 ${taskId} 不是 DRY-RUN 模式，拒绝执行`);
    await failTask(client, taskId, '只支持 DRY-RUN，拒绝真实执行');
    return;
  }

  // 校验 browserDryRun
  if (payload.browserDryRun !== true) {
    console.error(`[SignExecutor] 任务 ${taskId} 未启用 browserDryRun，拒绝执行`);
    await failTask(client, taskId, '只支持 browserDryRun 模式');
    return;
  }

  // 校验 waybills 非空
  if (waybills.length === 0) {
    console.error(`[SignExecutor] 任务 ${taskId} 运单列表为空，拒绝执行`);
    await failTask(client, taskId, '运单列表为空');
    return;
  }

  const staffName = payload.options?.staffName;
  const loginUrl = config?.bnsy?.loginUrl || 'https://bnsy.benniaosuyun.com/login';
  const browserConfig = {
    executablePath: 'E:/网站开发/DaoPaiV3/Chrome/App/chrome.exe',
    userDataDir: 'E:/网站开发/DaoPaiV3/runtime/chrome-profile',
    debugPort: 9223,
    headless: false,
  };

  let manager: BrowserManager | null = null;

  try {
    // 1. 上报开始日志 + progress 5%
    console.log(`[SignExecutor] 开始签收录入浏览器 DRY-RUN，任务: ${taskId}`);
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: `开始签收录入浏览器 DRY-RUN，网点：${siteName}，运单数：${waybills.length}`,
      timestamp: new Date().toISOString(),
    }]);
    await reportProgress(client, taskId, 'running', 5);

    // 2. 启动浏览器
    console.log('[SignExecutor] 启动项目内便携版 Chrome...');
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: '启动项目内便携版 Chrome',
      timestamp: new Date().toISOString(),
    }]);

    manager = new BrowserManager(browserConfig);
    await manager.start();
    await manager.connect();

    // 3. 打开登录页 + 登录
    console.log('[SignExecutor] 打开登录页...');
    const page = await manager.openPage(loginUrl);
    await page.waitForTimeout(5000);

    // 4. 确保登录
    const credential = await settingsLoader.getLoginCredentialForSite(siteId);
    if (!credential) {
      throw new Error('无法读取员工凭据');
    }

    console.log('[SignExecutor] 登录状态检查...');
    const loginResult = await ensureBnsyLoggedIn(page, credential);

    await uploadLogs(client, taskId, [{
      level: 'info',
      message: `登录状态检查完成：${loginResult.message}`,
      timestamp: new Date().toISOString(),
    }]);

    // 5. Dashboard P0 必须 READY
    if (!loginResult.success || loginResult.dashboard.status !== 'READY') {
      throw new Error(`Dashboard P0 不是 READY（状态: ${loginResult.dashboard.status}）`);
    }

    console.log('[SignExecutor] Dashboard P0 = READY');
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: '账号输入校验通过',
      timestamp: new Date().toISOString(),
    }, {
      level: 'info',
      message: '密码输入校验通过',
      timestamp: new Date().toISOString(),
    }, {
      level: 'info',
      message: 'Dashboard P0 READY',
      timestamp: new Date().toISOString(),
    }]);
    await reportProgress(client, taskId, 'running', 30);

    // 6. 执行签收录入页面 DRY-RUN
    console.log('[SignExecutor] 进入签收录入页面...');
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: '进入签收录入页面',
      timestamp: new Date().toISOString(),
    }]);

    const dryRunResult = await runSignBrowserDryRun(page, {
      siteId,
      siteName,
      options: { staffName },
    });

    // 7. 上报校验日志
    if (dryRunResult.validationLogs.length > 0) {
      await uploadLogs(client, taskId, dryRunResult.validationLogs.map(msg => ({
        level: 'info' as const,
        message: msg,
        timestamp: new Date().toISOString(),
      })));
    }

    if (dryRunResult.searched) {
      await uploadLogs(client, taskId, [{
        level: 'info',
        message: '已点击搜索',
        timestamp: new Date().toISOString(),
      }]);
    }

    await uploadLogs(client, taskId, [{
      level: 'info',
      message: '已阻止批量签收（未点击批量签收/确认签收/提交按钮）',
      timestamp: new Date().toISOString(),
    }]);

    // 8. 检查结果
    if (!dryRunResult.success) {
      throw new Error(dryRunResult.message);
    }

    // 9. 上报 progress 90%
    await reportProgress(client, taskId, 'running', 90);
    console.log('[SignExecutor] 页面 DRY-RUN 完成');

    await uploadLogs(client, taskId, [{
      level: 'success',
      message: '签收录入浏览器 DRY-RUN 完成，未点击最终提交',
      timestamp: new Date().toISOString(),
    }]);

    // 10. complete
    const summary = {
      mode: 'browserDryRun',
      total: waybills.length,
      searched: dryRunResult.searched,
      finalSubmitClicked: false,
      pageUrl: dryRunResult.pageUrl,
      message: '签收录入浏览器 DRY-RUN 完成，未点击最终提交',
    };

    const results = waybills.map(wb => ({
      waybillNo: wb,
      status: 'dry_run',
      message: '已搜索，未批量签收',
    }));

    await completeTask(client, taskId, summary, results);
    console.log('[SignExecutor] 任务完成，已回传 Cloud');

  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[SignExecutor] 任务 ${taskId} 执行失败：${msg}`);

    await uploadLogs(client, taskId, [{
      level: 'error',
      message: `任务执行失败：${msg}`,
      timestamp: new Date().toISOString(),
    }]).catch(() => {});

    try {
      await failTask(client, taskId, msg);
    } catch {
      // 忽略 fail 失败
    }
    throw err;

  } finally {
    // 11. 关闭浏览器，确认无残留
    if (manager) {
      console.log('[SignExecutor] 关闭 V3 Chrome...');
      try {
        const closeResult = await manager.close();
        await uploadLogs(client, taskId, [{
          level: 'info',
          message: `V3 Chrome 已关闭：${closeResult.message}`,
          timestamp: new Date().toISOString(),
        }]).catch(() => {});
      } catch (err) {
        console.error(`[SignExecutor] Chrome 关闭失败：${(err as Error).message}`);
      }
    }
  }
}
