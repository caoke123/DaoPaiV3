/**
 * DaoPai 本地执行端 — 启动入口
 *
 * 当前阶段：心跳闭环（Phase 4-E），不执行任务。
 * 后续 Phase 4-F 才做任务拉取与执行。
 */

import { loadConfig } from './config';
import { initLogger, logger, safeLog } from './logger';
import { startupCheck } from './startupCheck';
import { createHttpClient, getAgentMe, sendHeartbeat } from './httpClient';
import type { AgentConfig } from './types';

let shuttingDown = false;

async function main(): Promise<void> {
  console.log('========================================');
  console.log('  DaoPai 本地执行端 v0.1.0');
  console.log('  当前阶段：心跳闭环，尚未启用任务执行');
  console.log('========================================');
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

  console.log('');
  console.log('启动检查结果：');
  for (const item of result.items) {
    console.log(`  ${item}`);
  }

  if (result.warnings.length > 0) {
    console.log('');
    console.log('警告：');
    for (const w of result.warnings) {
      console.log(`  ⚠ ${w}`);
    }
  }

  console.log('');

  if (!result.ok) {
    logger.error('启动检查未通过，本地执行端退出');
    process.exit(1);
  }

  // 4. 创建 HTTP 客户端
  const client = createHttpClient(config);

  // 5. 验证授权码
  try {
    const me = await getAgentMe(client);
    console.log(`执行电脑：${me.name}`);
    console.log(`快递公司：${me.tenantName}`);
    console.log(`所属网点：${me.siteName || '未绑定'}`);
    console.log(`执行电脑编号：${me.workstationId}`);
    logger.info(`授权码验证成功，执行电脑：${me.name}`);
  } catch (err) {
    const msg = (err as Error).message;
    logger.error(`授权码验证失败：${msg}`);
    console.error(`错误：${msg}`);
    console.error('请检查执行电脑授权码是否正确，或联系管理员');
    process.exit(1);
  }

  console.log('');
  console.log('心跳循环已启动，每 15 秒上报一次...');
  console.log('按 Ctrl+C 停止\n');
  logger.info('心跳循环已启动');

  // 6. 心跳主循环
  const heartbeat = async () => {
    if (shuttingDown) return;

    try {
      const resp = await sendHeartbeat(client, {
        agentVersion: '0.1.0',
        machineFingerprint: 'placeholder',
        browserStatus: 'unknown',
        localStatus: {
          runningTaskId: null,
          pendingLogCount: 0,
          diskFreeMb: 0,
        },
      });

      if (resp.hasTask) {
        logger.info('Cloud 提示可能有任务等待（本阶段不拉取）');
      }
    } catch (err) {
      const msg = (err as Error).message;
      // 401/403 时停止心跳
      if (msg.includes('401') || msg.includes('403') || msg.includes('授权码无效') || msg.includes('已停用') || msg.includes('已删除')) {
        logger.error(`心跳失败（鉴权错误）：${msg}`);
        console.error(`心跳失败：${msg}`);
        console.error('执行电脑授权码可能已失效，请重新配置');
        shuttingDown = true;
        return;
      }
      safeLog('warn', `心跳失败：${msg}`, config.agentToken);
    }
  };

  // 立即发送第一次心跳
  await heartbeat();

  // 定时心跳
  const timer = setInterval(() => heartbeat(), config.heartbeatIntervalMs);

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