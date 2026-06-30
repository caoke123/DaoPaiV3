/**
 * ArrivalExecutor — 到件扫描 Agent DRY-RUN 执行器
 *
 * Phase 5-B: 只做 dryRun 模拟，不启动浏览器，不登录业务系统，不读取员工账号密码。
 * Phase 5-C 真实 Playwright 执行时再扩展。
 */

import type { AxiosInstance } from 'axios';
import {
  reportProgress,
  uploadLogs,
  completeTask,
  failTask,
} from '../httpClient';
import type { AgentSettingsLoader } from '../AgentSettingsLoader';

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
  };
}

/**
 * 执行 Arrival 到件扫描 DRY-RUN
 *
 * 模拟处理流程：
 *   1. 校验任务类型
 *   2. 校验 dryRun
 *   3. 读取 siteName
 *   4. 按运单模拟处理
 *   5. 上报 progress/logs
 *   6. complete
 */
export async function executeArrivalDryRun(
  task: ArrivalTask,
  client: AxiosInstance,
  settingsLoader: AgentSettingsLoader,
): Promise<void> {
  const { taskId, siteId, payload } = task;
  const waybills = payload.waybills || [];
  const batchSize = payload.options?.batchSize || 200;
  const siteName = payload.siteName || await settingsLoader.getSiteName(siteId);

  // 校验 dryRun
  if (payload.dryRun === false) {
    console.error(`[ArrivalExecutor] 任务 ${taskId} 不是 DRY-RUN 模式，拒绝执行`);
    await failTask(client, taskId, 'Phase 5-B 只支持 DRY-RUN，拒绝真实执行');
    return;
  }

  const totalWaybills = waybills.length;
  console.log(`发现到件扫描任务：${taskId}`);
  console.log(`网点：${siteName}，运单数：${totalWaybills}`);
  console.log(`模式：DRY-RUN（模拟执行，不启动浏览器）`);

  try {
    // 1. 上报开始日志
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: `开始到件扫描 DRY-RUN，网点：${siteName}，运单数：${totalWaybills}`,
      timestamp: new Date().toISOString(),
    }]);

    // 2. 上报 running 10%
    await reportProgress(client, taskId, 'running', 10);
    console.log(`进度：10%`);

    // 3. 按批次模拟处理运单
    const totalBatches = Math.ceil(totalWaybills / batchSize);
    let processed = 0;

    for (let batch = 0; batch < totalBatches; batch++) {
      const start = batch * batchSize;
      const end = Math.min(start + batchSize, totalWaybills);
      const batchWaybills = waybills.slice(start, end);

      // 模拟处理每一单
      for (const waybillNo of batchWaybills) {
        processed++;
        console.log(`模拟处理运单：${waybillNo}`);

        // 每 10 单或最后一批上报一次日志
        if (processed % 10 === 0 || processed === totalWaybills) {
          await uploadLogs(client, taskId, [{
            level: 'info',
            message: `DRY-RUN 模拟处理运单 ${processed}/${totalWaybills}`,
            timestamp: new Date().toISOString(),
          }]);
        }

        // 模拟处理延迟（每单 ~50ms，避免日志风暴）
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      // 每批上报进度
      const progress = Math.floor(10 + ((batch + 1) / totalBatches) * 85);
      await reportProgress(client, taskId, 'running', progress);
      console.log(`进度：${progress}% (第 ${batch + 1}/${totalBatches} 批)`);
    }

    // 4. 最终进度 100%
    await reportProgress(client, taskId, 'running', 100);
    console.log(`进度：100%`);

    // 5. 上报完成日志
    await uploadLogs(client, taskId, [{
      level: 'success',
      message: `到件扫描 DRY-RUN 完成，共处理 ${totalWaybills} 条运单`,
      timestamp: new Date().toISOString(),
    }]);

    // 6. complete
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