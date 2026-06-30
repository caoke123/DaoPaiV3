/**
 * BnsySessionManager — 笨鸟登录状态保持
 *
 * Phase 5-C-5: 检测当前是否已登录，复用已有登录态；
 * 未登录时自动调用 loginToBnsy 登录，然后验证 Dashboard P0。
 *
 * 硬性约束：
 *   - 不打印密码
 *   - 不上传密码到 Cloud
 *   - 不写入 task_logs
 */

import type { Page } from 'playwright-core';
import type { LoginCredential } from '../AgentSettingsLoader';
import { detectBnsyDashboardP0, type DashboardP0Result } from './BnsyDashboardDetector';
import { loginToBnsy } from './BnsyLoginExecutor';

export interface EnsureLoginResult {
  success: boolean;
  reusedSession: boolean;
  loginAttempted: boolean;
  dashboard: DashboardP0Result;
  message: string;
  warnings: string[];
}

export async function ensureBnsyLoggedIn(
  page: Page,
  credential: LoginCredential,
): Promise<EnsureLoginResult> {
  const warnings: string[] = [];

  // 1. 先检测当前 Dashboard P0
  const before = await detectBnsyDashboardP0(page);

  if (before.status === 'READY') {
    return {
      success: true,
      reusedSession: true,
      loginAttempted: false,
      dashboard: before,
      message: '已有登录态，Dashboard 就绪，无需重新登录',
      warnings,
    };
  }

  if (before.status === 'BLOCKED_POPUP') {
    warnings.push('Dashboard 存在阻塞弹窗，需要人工处理');
    return {
      success: false,
      reusedSession: false,
      loginAttempted: false,
      dashboard: before,
      message: 'Dashboard 存在阻塞弹窗，无法继续',
      warnings,
    };
  }

  if (before.status === 'LOGIN_REQUIRED') {
    // 2. 需要登录，调用 loginToBnsy
    console.log('  未登录，开始自动登录...');
    const loginResult = await loginToBnsy(page, credential);

    if (!loginResult.success) {
      warnings.push(...loginResult.warnings);
      return {
        success: false,
        reusedSession: false,
        loginAttempted: true,
        dashboard: {
          status: 'LOGIN_FAILED',
          url: loginResult.afterUrl,
          title: loginResult.title,
          isLoggedIn: false,
          isDashboard: false,
          hasCoreDom: false,
          hasBlockedPopup: false,
          coreSelectorsMatched: [],
          popupSelectorsMatched: [],
          pageTextPreview: '',
          message: loginResult.message,
          warnings: loginResult.warnings,
        },
        message: `登录失败：${loginResult.message}`,
        warnings,
      };
    }

    // 3. 登录成功，再次检测 Dashboard P0
    console.log('  登录成功，检测 Dashboard P0...');
    const after = await detectBnsyDashboardP0(page);

    if (after.status === 'READY') {
      return {
        success: true,
        reusedSession: false,
        loginAttempted: true,
        dashboard: after,
        message: '登录成功，Dashboard 就绪',
        warnings,
      };
    }

    // 登录后仍不是 READY
    warnings.push(`登录后 Dashboard 状态为 ${after.status}：${after.message}`);
    return {
      success: false,
      reusedSession: false,
      loginAttempted: true,
      dashboard: after,
      message: `登录成功但 Dashboard 未就绪：${after.message}`,
      warnings,
    };
  }

  // 4. 其他状态（PAGE_NOT_READY / LOGIN_FAILED / UNKNOWN）
  warnings.push(`Dashboard 状态异常：${before.status} - ${before.message}`);
  return {
    success: false,
    reusedSession: false,
    loginAttempted: false,
    dashboard: before,
    message: `Dashboard 状态异常：${before.message}`,
    warnings,
  };
}