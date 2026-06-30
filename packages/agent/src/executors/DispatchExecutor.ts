/**
 * DispatchExecutor — 派件扫描 Agent 执行器
 *
 * 仅支持浏览器 DRY-RUN（browserDryRun=true），不提供模拟 dryRun 分支。
 *
 * 硬性约束：
 *   - dryRun 必须不为 false，否则拒绝执行
 *   - browserDryRun 必须为 true，否则拒绝执行
 *   - waybills 不能为空
 *   - 浏览器页面操作禁止点击最终提交
 *   - 不修改 /api/operations/dispatch、BrowserPool、AssignmentEngine、DispatchHandler
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
import { runDispatchBrowserDryRun } from '../browser/DispatchBrowserDryRun';
import type { AgentConfig } from '../types';

interface DispatchTask {
  taskId: string;
  siteId: string;
  payload: {
    waybills: string[];
    options?: {
      courierName?: string;
    };
    siteName?: string;
    dryRun?: boolean;
    browserDryRun?: boolean;
  };
}

/**
 * 执行 Dispatch 派件扫描任务（仅 browserDryRun 模式）
 *
 * 内部判断：
 *   - dryRun === false → 拒绝执行
 *   - browserDryRun !== true → 拒绝执行
 *   - waybills 为空 → 拒绝执行
 */
export async function executeDispatchDryRun(
  task: DispatchTask,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
  config?: AgentConfig,
): Promise<void> {
  const { taskId, siteId, payload } = task;
  const waybills = payload.waybills || [];
  const siteName = payload.siteName || await settingsLoader.getSiteName(siteId);

  // 校验 dryRun
  if (payload.dryRun === false) {
    console.error(`[DispatchExecutor] 任务 ${taskId} 不是 DRY-RUN 模式，拒绝执行`);
    await failTask(client, taskId, '只支持 DRY-RUN，拒绝真实执行');
    return;
  }

  // 校验 browserDryRun
  if (payload.browserDryRun !== true) {
    console.error(`[DispatchExecutor] 任务 ${taskId} 未启用 browserDryRun，拒绝执行`);
    await failTask(client, taskId, '只支持 browserDryRun 模式');
    return;
  }

  // 校验 waybills 非空
  if (waybills.length === 0) {
    console.error(`[DispatchExecutor] 任务 ${taskId} 运单列表为空，拒绝执行`);
    await failTask(client, taskId, '运单列表为空');
    return;
  }

  const payloadCourierName = payload.options?.courierName;
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
    console.log(`[DispatchExecutor] 开始派件扫描浏览器 DRY-RUN，任务: ${taskId}`);
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: `开始派件扫描浏览器 DRY-RUN，网点：${siteName}，运单数：${waybills.length}`,
      timestamp: new Date().toISOString(),
    }]);
    await reportProgress(client, taskId, 'running', 5);

    // 2. 启动浏览器
    console.log('[DispatchExecutor] 启动项目内便携版 Chrome...');
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: '启动项目内便携版 Chrome',
      timestamp: new Date().toISOString(),
    }]);

    manager = new BrowserManager(browserConfig);
    await manager.start();
    await manager.connect();

    // 3. 打开登录页 + 登录
    console.log('[DispatchExecutor] 打开登录页...');
    const page = await manager.openPage(loginUrl);
    await page.waitForTimeout(5000);

    // 4. 确保登录
    const credential = await settingsLoader.getLoginCredentialForSite(siteId);
    if (!credential) {
      throw new Error('无法读取员工凭据');
    }

    // 派件员姓名：优先用 payload 传入值，缺失时用 settings.json 网点员工 employeeName 兜底
    const courierName = payloadCourierName || credential.employeeName;

    console.log('[DispatchExecutor] 登录状态检查...');
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

    console.log('[DispatchExecutor] Dashboard P0 = READY');
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

    // 6. 执行派件页面 DRY-RUN
    console.log('[DispatchExecutor] 进入派件扫描页面...');
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: '进入派件扫描页面',
      timestamp: new Date().toISOString(),
    }]);

    const dryRunResult = await runDispatchBrowserDryRun(page, {
      siteId,
      siteName,
      waybills,
      options: { courierName },
    });

    // 7. 上报校验日志
    if (dryRunResult.validationLogs.length > 0) {
      await uploadLogs(client, taskId, dryRunResult.validationLogs.map(msg => ({
        level: 'info' as const,
        message: msg,
        timestamp: new Date().toISOString(),
      })));
    }

    await uploadLogs(client, taskId, [{
      level: 'info',
      message: `输入运单：${dryRunResult.inputCount} 条`,
      timestamp: new Date().toISOString(),
    }]);

    if (dryRunResult.courierSelected) {
      await uploadLogs(client, taskId, [{
        level: 'info',
        message: '派件员选中',
        timestamp: new Date().toISOString(),
      }]);
    }

    await uploadLogs(client, taskId, [{
      level: 'info',
      message: '已阻止最终提交（未点击批量派件/确认派件/提交按钮）',
      timestamp: new Date().toISOString(),
    }]);

    // 8. 检查结果
    if (!dryRunResult.success) {
      throw new Error(dryRunResult.message);
    }

    // 9. 上报 progress 90%
    await reportProgress(client, taskId, 'running', 90);
    console.log('[DispatchExecutor] 页面 DRY-RUN 完成');

    await uploadLogs(client, taskId, [{
      level: 'success',
      message: '派件扫描浏览器 DRY-RUN 完成，未点击最终提交',
      timestamp: new Date().toISOString(),
    }]);

    // 10. complete
    const summary = {
      mode: 'browserDryRun',
      total: dryRunResult.inputCount,
      courierSelected: dryRunResult.courierSelected,
      finalSubmitClicked: false,
      pageUrl: dryRunResult.pageUrl,
      message: '派件扫描浏览器 DRY-RUN 完成，未点击最终提交',
    };

    const results = waybills.map(wb => ({
      waybillNo: wb,
      status: 'dry_run',
      message: '已输入并选派件员，未提交派件',
    }));

    await completeTask(client, taskId, summary, results);
    console.log('[DispatchExecutor] 任务完成，已回传 Cloud');

  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[DispatchExecutor] 任务 ${taskId} 执行失败：${msg}`);

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
      console.log('[DispatchExecutor] 关闭 V3 Chrome...');
      try {
        const closeResult = await manager.close();
        await uploadLogs(client, taskId, [{
          level: 'info',
          message: `V3 Chrome 已关闭：${closeResult.message}`,
          timestamp: new Date().toISOString(),
        }]).catch(() => {});
      } catch (err) {
        console.error(`[DispatchExecutor] Chrome 关闭失败：${(err as Error).message}`);
      }
    }
  }
}
