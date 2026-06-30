/**
 * DaoPai 本地执行端 — 启动入口
 *
 * 当前阶段：骨架模式，仅执行启动检查，不执行任务。
 * 后续 Phase 4-E 才做心跳闭环，Phase 4-F 才做任务拉取与执行。
 */

import { loadConfig } from './config';
import { initLogger, logger } from './logger';
import { startupCheck } from './startupCheck';

async function main(): Promise<void> {
  console.log('========================================');
  console.log('  DaoPai 本地执行端 v0.1.0');
  console.log('  当前阶段：骨架模式，尚未启用任务执行');
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

  console.log('配置检查通过');
  console.log('本地日志目录已就绪');
  console.log(`Cloud 地址：${config.cloudBaseUrl}`);
  console.log(`执行电脑：${config.workstationName}`);
  console.log('当前阶段：骨架模式，尚未启用任务执行');
  console.log('');
  console.log('后续计划：');
  console.log('  Phase 4-E：心跳与在线状态闭环');
  console.log('  Phase 4-F：任务拉取与结果回传最小闭环');
  console.log('');

  // 骨架模式：安全退出
  // 后续 Phase 4-E 将替换为心跳主循环
  logger.info('骨架模式启动检查完成，安全退出');
  process.exit(0);
}

main().catch((err) => {
  console.error('本地执行端启动失败：', err.message);
  process.exit(1);
});