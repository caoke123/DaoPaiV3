/**
 * DaoPai 本地执行端 — 启动入口
 *
 * Phase 5-B: 支持 agent_test + arrival DRY-RUN 任务。
 * 不接真实浏览器，不启动 Playwright。
 */

import { loadConfig } from './config';
import { execSync } from 'node:child_process';
import { initLogger, logger, safeLog } from './logger';
import { startupCheck } from './startupCheck';
import {
  createHttpClient,
  getAgentMe,
  sendHeartbeat,
  pullTask,
  runTaskWithBackendEngine,
  reportProgress,
  uploadLogs,
  completeTask,
  failTask,
} from './httpClient';
import { AgentSettingsLoader } from './AgentSettingsLoader';
import { executeArrivalDryRun } from './executors/ArrivalExecutor';
import { executeDispatchDryRun } from './executors/DispatchExecutor';
import { executeSignDryRun } from './executors/SignExecutor';
import { executeIntegratedDryRun } from './executors/IntegratedExecutor';
import type { AxiosInstance } from 'axios';
import type { AgentConfig } from './types';

let shuttingDown = false;
let runningTaskId: string | null = null;

function getRuntimeGitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: process.cwd(), encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function logAgentRuntimeProof(): void {
  console.log(`[RuntimeProof][Agent] phase=K-3A-2 arrivalReadyTakeover=true buildTime=${new Date().toISOString()} git=${getRuntimeGitHash()}`);
  console.log(`[RuntimeProof][Agent] phase=K-3B dispatchReadyTakeover=true buildTime=${new Date().toISOString()} git=${getRuntimeGitHash()}`);
  console.log(`[RuntimeProof][Agent] phase=K-3C signReadyTakeover=true buildTime=${new Date().toISOString()} git=${getRuntimeGitHash()}`);
  console.log(`[RuntimeProof][Agent] phase=K-3D integratedReadyTakeover=true buildTime=${new Date().toISOString()} git=${getRuntimeGitHash()}`);
}

async function executeAgentTestTask(
  client: AxiosInstance,
  taskId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const durationMs = (payload.durationMs as number) || 3000;
  const message = (payload.message as string) || 'Agent 测试任务';

  console.log(`发现测试任务：${taskId}`);
  console.log(`任务内容：${message}`);
  console.log(`模拟执行时长：${durationMs}ms`);
  logger.info(`开始执行测试任务 ${taskId}`);

  try {
    // 1. 上报开始日志
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: `开始测试任务：${message}`,
      timestamp: new Date().toISOString(),
    }]);

    // 2. 上报 running 10%
    await reportProgress(client, taskId, 'running', 10);
    console.log('进度：10%');
    logger.info(`任务 ${taskId} 进度：10%`);

    // 3. 模拟执行
    await new Promise(resolve => setTimeout(resolve, durationMs / 2));

    // 4. 上报 50%
    await reportProgress(client, taskId, 'running', 50);
    await uploadLogs(client, taskId, [{
      level: 'info',
      message: '测试任务执行中...',
      timestamp: new Date().toISOString(),
    }]);
    console.log('进度：50%');
    logger.info(`任务 ${taskId} 进度：50%`);

    // 5. 继续模拟
    await new Promise(resolve => setTimeout(resolve, durationMs / 2));

    // 6. 上报 100%
    await reportProgress(client, taskId, 'running', 100);
    console.log('进度：100%');
    logger.info(`任务 ${taskId} 进度：100%`);

    // 7. 上报完成日志
    await uploadLogs(client, taskId, [{
      level: 'success',
      message: '测试任务完成',
      timestamp: new Date().toISOString(),
    }]);

    // 8. complete
    await completeTask(client, taskId);
    console.log('测试任务完成，已回传 Cloud');
    logger.info(`任务 ${taskId} 已完成`);
  } catch (err) {
    const msg = (err as Error).message;
    logger.error(`任务 ${taskId} 执行失败：${msg}`);
    console.error(`任务执行失败：${msg}`);

    try {
      await failTask(client, taskId, msg);
      logger.info(`任务 ${taskId} 已标记为 failed`);
    } catch {
      logger.error(`任务 ${taskId} 标记失败时出错`);
    }
  }
}

function logBusinessTaskPayload(task: { taskId: string; type: string; siteId: string; payload: Record<string, unknown> }): void {
  const payload = task.payload || {};
  const assignments = Array.isArray((payload as any).assignments) ? (payload as any).assignments : [];
  const assignmentsPreview = assignments.map((a: any) => ({
    staffName: a?.staffName,
    siteId: a?.siteId,
    windowId: a?.windowId,
    browserId: a?.browserId,
    runtimeKey: a?.runtimeKey,
    waybillCount: Array.isArray(a?.waybillNos) ? a.waybillNos.length : 0,
  }));
  console.log('[Agent][task payload]', {
    taskId: task.taskId,
    type: task.type,
    siteId: task.siteId,
    hasPayload: !!payload,
    assignmentCount: assignments.length,
    assignmentsPreview,
  });
}

async function executeBusinessTaskWithBackendEngine(
  client: AxiosInstance,
  task: { taskId: string; type: string; siteId: string; payload: Record<string, unknown> },
): Promise<void> {
  logBusinessTaskPayload(task);
  const label = `Agent-run-engine-${task.taskId}`;
  console.time(label);

  // Phase 5-J-1: 从 payload.assignments 提取 staffName/windowId 用于日志上下文
  // 字段缺失时允许为空，但必须记录 warn 日志说明来源缺失（避免日志静默落入全局区）
  const assignments = Array.isArray((task.payload as any)?.assignments) ? (task.payload as any).assignments : [];
  const firstStaff = assignments[0]?.staffName || '';
  const firstWindowId = assignments[0]?.windowId || '';

  if (!firstStaff) {
    logger.warn(`[Agent日志] staffName 来源缺失：task=${task.taskId} assignments.length=${assignments.length}，日志将降级到全局区`);
  }
  if (!firstWindowId) {
    logger.warn(`[Agent日志] windowId 来源缺失：task=${task.taskId} assignments.length=${assignments.length}，日志将降级到全局区`);
  }

  console.log(`[Agent日志] 上传日志：staffName=${firstStaff || '(空)'}, windowId=${firstWindowId || '(空)'}, siteId=${task.siteId || '(空)'}, count=1`);

  await uploadLogs(client, task.taskId, [{
    level: 'info',
    message: `[兼容路径] 任务类型 ${task.type} 暂未迁移，继续使用 Cloud run-engine 兼容路径。正式方向是 Agent 本地执行；Arrival 已从 Phase K-2A 开始迁移。`,
    timestamp: new Date().toISOString(),
    staffName: firstStaff,
    windowId: firstWindowId,
    siteId: task.siteId,
  }]);

  console.time(`Agent-run-engine-POST-${task.taskId}`);
  await runTaskWithBackendEngine(client, task.taskId);
  console.timeEnd(`Agent-run-engine-POST-${task.taskId}`);
  console.timeEnd(label);
}

async function main(): Promise<void> {
  console.log('========================================');
  console.log('  DaoPai 本地执行端 v0.1.0');
  console.log('  当前阶段：任务管道最小闭环，模拟执行');
  console.log('========================================');
  logAgentRuntimeProof();
  console.log('');

  // 1. 加载配置
  const config = loadConfig();

  // 2. 初始化日志系统
  initLogger(config.logLevel);

  logger.info('DaoPai 本地执行端启动中...');
  logger.info(`Cloud 地址：${config.cloudBaseUrl}`);
  logger.info(`执行电脑：${config.workstationName}`);

  // 3. 启动检查
  console.log('正在执行启动检查...\n');
  const result = await startupCheck(config);

  if (!result.ok) {
    logger.error('启动检查未通过，本地执行端退出');
    process.exit(1);
  }

  // 4. 创建 HTTP 客户端
  const client = createHttpClient(config);

  // 5. 初始化 settingsLoader
  const settingsLoader = new AgentSettingsLoader(config.settingsPath);
  console.log(`settings.json 路径：${settingsLoader['settingsPath']}`);

  // 6. 验证授权码
  try {
    const me = await getAgentMe(client);
    console.log(`执行电脑：${me.name}`);
    console.log(`快递公司：${me.tenantName}`);
    console.log(`所属网点：${me.siteName || '未绑定'}`);
    logger.info(`授权码验证成功，执行电脑：${me.name}`);
  } catch (err) {
    const msg = (err as Error).message;
    logger.error(`授权码验证失败：${msg}`);
    console.error(`错误：${msg}`);
    process.exit(1);
  }

  console.log('');
  console.log(`心跳循环已启动，每 ${(config.heartbeatIntervalMs / 1000).toFixed(0)} 秒上报一次...`);
  console.log(`  heartbeatIntervalMs=${config.heartbeatIntervalMs}`);
  console.log(`  taskPollIntervalMs=${config.taskPollIntervalMs}`);
  console.log('按 Ctrl+C 停止\n');
  logger.info('心跳循环已启动');

  // 6. 心跳 + 任务轮询主循环
  const tick = async () => {
    if (shuttingDown) return;

    try {
      // 发送心跳（如果正在执行任务，告知 Cloud）
      const resp = await sendHeartbeat(client, {
        agentVersion: '0.1.0',
        machineFingerprint: 'placeholder',
        browserStatus: 'unknown',
        localStatus: {
          runningTaskId,
          pendingLogCount: 0,
          diskFreeMb: 0,
        },
      });

      // 如果有任务且当前没有在执行，拉取任务
      if (resp.hasTask && !runningTaskId) {
        try {
          const pullStart = Date.now();
          const pullResp = await pullTask(client);
          console.log(`[Agent] pullTask 耗时 ${Date.now() - pullStart}ms, hasTask=${pullResp.hasTask}`);
          if (pullResp.hasTask && pullResp.task) {
            const task = pullResp.task;
            console.log(`[Agent] T3 拉到任务: taskId=${task.taskId} type=${task.type} siteId=${task.siteId}`);
            const assignments = Array.isArray((task.payload as any)?.assignments) ? (task.payload as any).assignments : [];
            console.log(`[Agent] pulled task: id=${task.taskId}, type=${task.type}, assignments=${assignments.length}`);

            // agent_test 任务
            if (task.type === 'agent_test') {
              runningTaskId = task.taskId;
              await executeAgentTestTask(client, task.taskId, task.payload);
              runningTaskId = null;
            }
            // Phase K-2A: Arrival 已迁回 Agent 本地执行器。
            // 这是 V3 正式方向：Cloud 只创建任务/保存状态，浏览器动作发生在 Agent 进程内。
            else if (task.type === 'arrival' || task.type === 'arrive' || (task as any).taskType === 'arrival' || (task as any).taskType === 'arrive') {
              console.log(`[Agent] 收到 Arrival 任务，使用 Agent 本地执行器`);
              console.log(`[Agent] Arrival 本地执行开始，taskId=${task.taskId}`);
              logger.info(`[Agent] 收到 Arrival 任务，使用 Agent 本地执行器 taskId=${task.taskId}`);
              runningTaskId = task.taskId;
              await executeArrivalDryRun(task as any, client, settingsLoader, config);
              console.log(`[Agent] Arrival 本地执行结束，taskId=${task.taskId}`);
              runningTaskId = null;
            }
            // Phase K-2B: Dispatch 已迁回 Agent 本地执行器。
            else if (task.type === 'dispatch' || (task as any).taskType === 'dispatch') {
              console.log(`[Agent] 收到 Dispatch 任务，使用 Agent 本地执行器`);
              console.log(`[Agent] Dispatch 本地执行开始，taskId=${task.taskId}`);
              logger.info(`[Agent] 收到 Dispatch 任务，使用 Agent 本地执行器 taskId=${task.taskId}`);
              runningTaskId = task.taskId;
              await executeDispatchDryRun(task as any, client, settingsLoader, config);
              console.log(`[Agent] Dispatch 本地执行结束，taskId=${task.taskId}`);
              runningTaskId = null;
            }
            // Phase K-2D: Sign 已迁回 Agent 本地执行器。
            else if (task.type === 'sign' || (task as any).taskType === 'sign') {
              console.log(`[Agent] 收到 Sign 任务，使用 Agent 本地执行器`);
              console.log(`[Agent][Sign] 本地执行开始，taskId=${task.taskId}`);
              logger.info(`[Agent] 收到 Sign 任务，使用 Agent 本地执行器 taskId=${task.taskId}`);
              runningTaskId = task.taskId;
              await executeSignDryRun(task as any, client, settingsLoader, config);
              console.log(`[Agent] Sign 本地执行结束，taskId=${task.taskId}`);
              runningTaskId = null;
            }
            // Phase K-2D: Integrated 已迁回 Agent 本地执行器。
            else if (task.type === 'integrated' || (task as any).taskType === 'integrated') {
              console.log(`[Agent] 收到 Integrated 任务，使用 Agent 本地执行器`);
              console.log(`[Agent][Integrated] 本地执行开始，taskId=${task.taskId}`);
              logger.info(`[Agent] 收到 Integrated 任务，使用 Agent 本地执行器 taskId=${task.taskId}`);
              runningTaskId = task.taskId;
              await executeIntegratedDryRun(task as any, client, settingsLoader, config);
              console.log(`[Agent] Integrated 本地执行结束，taskId=${task.taskId}`);
              runningTaskId = null;
            }
            // 未识别任务类型：保留 run-engine 兼容路径，由 Cloud 端判断是否支持。
            else {
              console.log(`[Agent] 任务类型 ${task.type} 未识别，继续使用 Cloud run-engine 兼容路径`);
              runningTaskId = task.taskId;
              await executeBusinessTaskWithBackendEngine(client, task);
              runningTaskId = null;
            }
          }
        } catch (err) {
          const msg = (err as Error).message;
          safeLog('warn', `任务拉取失败：${msg}`, config.agentToken);
          // Phase 5-G-3-2: Executor 异常时必须更新 PG 任务状态，否则任务卡在 assigned 无法被重新拉取
          if (runningTaskId) {
            await failTask(client, runningTaskId, msg).catch(() => {});
          }
          runningTaskId = null;
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('401') || msg.includes('403') || msg.includes('授权码') || msg.includes('已停用')) {
        logger.error(`心跳失败（鉴权错误）：${msg}`);
        console.error(`心跳失败：${msg}`);
        shuttingDown = true;
        return;
      }
      safeLog('warn', `心跳失败：${msg}`, config.agentToken);
    }
  };

  // 立即执行第一次
  await tick();

  // 定时循环
  const timer = setInterval(() => tick(), config.heartbeatIntervalMs);

  // 优雅退出
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n正在停止本地执行端...');
    clearInterval(timer);
    logger.info('本地执行端已停止');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('本地执行端启动失败：', err.message);
  process.exit(1);
});
