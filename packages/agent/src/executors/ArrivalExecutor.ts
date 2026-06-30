/**
 * ArrivalExecutor — 到件扫描 Agent 执行器
 *
 * Phase 5-B: 模拟 dryRun，不启动浏览器
 * Phase 5-E: 接入浏览器 DRY-RUN（payload.browserDryRun=true 时）
 *
 * 硬性约束：
 *   - dryRun 必须为 true，否则拒绝执行
 *   - browserDryRun=true 时执行浏览器页面操作，但禁止点击最终提交
 *   - 不修改 /api/operations/arrive、BrowserPool、AssignmentEngine、ArrivalHandler
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
import { runArrivalBrowserDryRun } from '../browser/ArrivalBrowserDryRun';
import type { AgentConfig } from '../types';

interface ArrivalTask {
  taskId: string;
  siteId: string;
  payload: {
    waybills: string[];
    options?: {
      batchSize?: number;
      prevStation?: string;
    };
    siteName?: string;
    dryRun?: boolean;
    browserDryRun?: boolean;
  };
}

/**
 * 执行 Arrival 到件扫描任务
 *
 * 内部判断：
 *   - payload.browserDryRun === true → 浏览器 DRY-RUN
 *   - 否则 → 模拟 DRY-RUN（Phase 5-B 兼容）
 */
export async function executeArrivalDryRun(
  task: ArrivalTask,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
  config?: AgentConfig,
): Promise<void> {
  const { taskId, siteId, payload } = task;
  const waybills = payload.waybills || [];
  const siteName = payload.siteName || await settingsLoader.getSiteName(siteId);

  // 校验 dryRun
  if (payload.dryRun === false) {
    console.error(`[ArrivalExecutor] 任务 ${taskId} 不是 DRY-RUN 模式，拒绝执行`);
    await failTask(client, taskId, '只支持 DRY-RUN，拒绝真实执行');
    return;
  }

  // 根据 browserDryRun 分支
  if (payload.browserDryRun === true) {
    await executeBrowserDryRun(task, client, settingsLoader, config);
  } else {
    await executeSimulatedDryRun(task, client, settingsLoader);
  }
}

// ══════════════════════════════════════════════════════════
// 浏览器 DRY-RUN（Phase 5-E）
// ══════════════════════════════════════════════════════════

async function executeBrowserDryRun(
  task: ArrivalTask,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
  config?: AgentConfig,
): Promise<void> {
  const { taskId, siteId, payload } = task;
  const waybills = payload.waybills || [];
  const siteName = payload.siteName || await settingsLoader.getSiteName(siteId);
  const prevStation = payload.options?.prevStation || '天津分拨中心';

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
    console.log(`[ArrivalExecutor] 开始到件扫描浏览器 DRY-RUN，任务: ${taskId}`);
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: `开始到件扫描浏览器 DRY-RUN，网点：${siteName}，运单数：${waybills.length}`,
      timestamp: new Date().toISOString(),
    }]);
    await reportProgress(client, taskId, 'running', 5);

    // 2. 启动浏览器
    console.log('[ArrivalExecutor] 启动项目内便携版 Chrome...');
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: '启动项目内便携版 Chrome',
      timestamp: new Date().toISOString(),
    }]);

    manager = new BrowserManager(browserConfig);
    await manager.start();
    await manager.connect();

    // 3. 打开登录页 + 登录
    console.log('[ArrivalExecutor] 打开登录页...');
    const page = await manager.openPage(loginUrl);
    await page.waitForTimeout(5000);

    // 4. 确保登录
    const credential = await settingsLoader.getLoginCredentialForSite(siteId);
    if (!credential) {
      throw new Error('无法读取员工凭据');
    }

    console.log('[ArrivalExecutor] 登录状态检查...');
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

    console.log('[ArrivalExecutor] Dashboard P0 = READY');
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: 'Dashboard P0 READY',
      timestamp: new Date().toISOString(),
    }]);
    await reportProgress(client, taskId, 'running', 30);

    // 6. 执行到件页面 DRY-RUN
    console.log('[ArrivalExecutor] 进入到件扫描页面...');
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: '进入到件扫描页面',
      timestamp: new Date().toISOString(),
    }]);

    const dryRunResult = await runArrivalBrowserDryRun(page, {
      siteId,
      siteName,
      waybills,
      options: { prevStation },
    });

    // 7. 上报日志
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: `输入运单：${dryRunResult.inputCount} 条`,
      timestamp: new Date().toISOString(),
    }]);

    if (dryRunResult.queried) {
      await uploadLogs(client, taskId, [{
        level: 'info',
        message: '点击查询按钮',
        timestamp: new Date().toISOString(),
      }]);
    }

    await uploadLogs(client, taskId, [{
      level: 'info',
      message: '已阻止最终提交（未点击批量到件/确认到件/提交按钮）',
      timestamp: new Date().toISOString(),
    }]);

    // 8. 检查结果
    if (!dryRunResult.success) {
      throw new Error(dryRunResult.message);
    }

    // 9. 上报 progress 90%
    await reportProgress(client, taskId, 'running', 90);
    console.log('[ArrivalExecutor] 页面 DRY-RUN 完成');

    await uploadLogs(client, taskId, [{
      level: 'success',
      message: '到件扫描浏览器 DRY-RUN 完成，未点击最终提交',
      timestamp: new Date().toISOString(),
    }]);

    // 10. complete
    const summary = {
      mode: 'browserDryRun',
      total: dryRunResult.inputCount,
      queried: dryRunResult.queried,
      finalSubmitClicked: false,
      pageUrl: dryRunResult.pageUrl,
      message: '到件扫描浏览器 DRY-RUN 完成，未点击最终提交',
    };

    const results = waybills.map(wb => ({
      waybillNo: wb,
      status: 'dry_run',
      message: '已输入并查询，未提交到件',
    }));

    await completeTask(client, taskId, summary, results);
    console.log('[ArrivalExecutor] 任务完成，已回传 Cloud');

  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[ArrivalExecutor] 任务 ${taskId} 执行失败：${msg}`);

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
      console.log('[ArrivalExecutor] 关闭 V3 Chrome...');
      try {
        const closeResult = await manager.close();
        await uploadLogs(client, taskId, [{
          level: 'info',
          message: `V3 Chrome 已关闭：${closeResult.message}`,
          timestamp: new Date().toISOString(),
        }]).catch(() => {});
      } catch (err) {
        console.error(`[ArrivalExecutor] Chrome 关闭失败：${(err as Error).message}`);
      }
    }
  }
}

// ══════════════════════════════════════════════════════════
// 模拟 DRY-RUN（Phase 5-B 兼容，不启动浏览器）
// ══════════════════════════════════════════════════════════

async function executeSimulatedDryRun(
  task: ArrivalTask,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
): Promise<void> {
  const { taskId, siteId, payload } = task;
  const waybills = payload.waybills || [];
  const batchSize = payload.options?.batchSize || 200;
  const siteName = payload.siteName || await settingsLoader.getSiteName(siteId);

  const totalWaybills = waybills.length;
  console.log(`[ArrivalExecutor] 发现到件扫描任务：${taskId}`);
  console.log(`[ArrivalExecutor] 网点：${siteName}，运单数：${totalWaybills}`);
  console.log(`[ArrivalExecutor] 模式：模拟 DRY-RUN（不启动浏览器）`);

  try {
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: `开始到件扫描 DRY-RUN，网点：${siteName}，运单数：${totalWaybills}`,
      timestamp: new Date().toISOString(),
    }]);

    await reportProgress(client, taskId, 'running', 10);
    console.log(`进度：10%`);

    const totalBatches = Math.ceil(totalWaybills / batchSize);
    let processed = 0;

    for (let batch = 0; batch < totalBatches; batch++) {
      const start = batch * batchSize;
      const end = Math.min(start + batchSize, totalWaybills);
      const batchWaybills = waybills.slice(start, end);

      for (const waybillNo of batchWaybills) {
        processed++;
        console.log(`模拟处理运单：${waybillNo}`);

        if (processed % 10 === 0 || processed === totalWaybills) {
          await uploadLogs(client, taskId, [{
            level: 'info',
            message: `DRY-RUN 模拟处理运单 ${processed}/${totalWaybills}`,
            timestamp: new Date().toISOString(),
          }]);
        }

        await new Promise(resolve => setTimeout(resolve, 50));
      }

      const progress = Math.floor(10 + ((batch + 1) / totalBatches) * 85);
      await reportProgress(client, taskId, 'running', progress);
      console.log(`进度：${progress}% (第 ${batch + 1}/${totalBatches} 批)`);
    }

    await reportProgress(client, taskId, 'running', 100);
    console.log(`进度：100%`);

    await uploadLogs(client, taskId, [{
      level: 'success',
      message: `到件扫描 DRY-RUN 完成，共处理 ${totalWaybills} 条运单`,
      timestamp: new Date().toISOString(),
    }]);

    await completeTask(client, taskId);
    console.log('到件扫描 DRY-RUN 完成，已回传 Cloud');
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`到件扫描任务 ${taskId} 执行失败：${msg}`);

    try {
      await failTask(client, taskId, msg);
    } catch {
      // 忽略 fail 失败
    }
    throw err;
  }
}
