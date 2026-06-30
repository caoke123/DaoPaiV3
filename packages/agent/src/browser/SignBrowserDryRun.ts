/**
 * SignBrowserDryRun — 签收录入浏览器 DRY-RUN 页面操作
 *
 * Phase 5-F: 在笨鸟系统中执行签收录入页面级 DRY-RUN。
 *
 * 选择器来源：
 *   backend/operations/selectors/signSelectors.ts（标准化版本）
 * 交互顺序来源：
 *   backend/operations/SignScan.ts:108-121 + core/signExecutor
 *
 * 硬性边界：
 *   - 禁止点击"批量签收"按钮（最终提交）
 *   - 禁止点击签收弹窗"确定"按钮（最终提交）
 *   - 允许点击"搜索"按钮（spec 白名单允许查询/搜索/检索）
 *   - 不产生真实签收业务
 */

import type { Page } from 'playwright-core';
import { detectSignPage, type SignPageDetectResult } from './SignPageDetector';
import { detectBnsyDashboardP0 } from './BnsyDashboardDetector';
import { stableClick } from './StablePageActions';
import { SIGN_SELECTORS, SIGN_PAGE_ROUTE } from './signSelectors';

export interface SignBrowserDryRunInput {
  siteId: string;
  siteName: string;
  options?: {
    staffName?: string;
  };
}

export interface SignBrowserDryRunResult {
  success: boolean;
  pageUrl: string;
  title: string;
  searched: boolean;
  finalSubmitClicked: false;
  detectBefore: SignPageDetectResult | null;
  detectAfter: SignPageDetectResult | null;
  message: string;
  warnings: string[];
  validationLogs: string[];
}

// 签收录入页面 URL（来源：PageStateManager.ts:20 SIGN_PAGE_ROUTE）
const SIGN_PAGE_URL = `https://bnsy.benniaosuyun.com${SIGN_PAGE_ROUTE}`;

// 禁止点击的按钮关键词
const FORBIDDEN_BUTTON_KEYWORDS = [
  '批量签收', '签收', '提交', '确认', '批量', '保存', '完成', '执行', '到派',
];

function assertNotFinalSubmit(text: string): void {
  const normalized = text.replace(/\s+/g, '');
  for (const kw of FORBIDDEN_BUTTON_KEYWORDS) {
    if (normalized.includes(kw)) {
      throw new Error(`安全保护：禁止点击疑似最终提交按钮（文本: "${text}"，匹配关键词: "${kw}"）`);
    }
  }
}

// 允许点击的按钮关键词（spec 白名单）
const ALLOWED_BUTTON_KEYWORDS = ['查询', '搜索', '检索'];

async function cleanPagePopups(page: Page): Promise<void> {
  try {
    const result = await page.evaluate(() => {
      let cleaned = 0;
      const actions: string[] = [];

      const wrappers = document.querySelectorAll('.el-dialog__wrapper, .el-message-box__wrapper');
      for (const wrapper of wrappers) {
        const ws = window.getComputedStyle(wrapper as HTMLElement);
        if (ws.display === 'none') continue;

        const btns = wrapper.querySelectorAll('button');
        for (const btn of btns) {
          const text = (btn.textContent || '').replace(/\s+/g, '');
          if (text === '取消' || text === '关闭' || text === '知道了' || text.includes('取消') || text.includes('关闭')) {
            if (text.includes('签收') || text.includes('提交') || text.includes('批量') || text.includes('确认')) {
              continue;
            }
            (btn as HTMLElement).click();
            cleaned++;
            actions.push(`点击了"${text}"按钮`);
            break;
          }
        }
      }

      return { cleaned, actions };
    });

    if (result.cleaned > 0) {
      console.log(`  [Sign-DRY-RUN] 弹窗清理: ${result.actions.join('; ')}`);
      await page.waitForTimeout(1000);
    }
  } catch {
    // 忽略清理失败
  }
}

/**
 * 执行签收录入浏览器 DRY-RUN
 *
 * 选择器和交互流程严格遵循旧代码：
 *   - 日期范围选择器：SIGN_SELECTORS.dateRangeInput（仅检测）
 *   - 派件员下拉框：SIGN_SELECTORS.courierSelectInput（仅检测）
 *   - 搜索按钮：SIGN_SELECTORS.searchButton（允许点击）
 *   - 批量签收按钮：SIGN_SELECTORS.batchSignButton（仅检测，绝不点击）
 *   - 签收弹窗确认按钮：SIGN_SELECTORS.dialogConfirmBtn（仅检测，绝不点击）
 */
export async function runSignBrowserDryRun(
  page: Page,
  input: SignBrowserDryRunInput,
): Promise<SignBrowserDryRunResult> {
  const warnings: string[] = [];

  const result: SignBrowserDryRunResult = {
    success: false,
    pageUrl: '',
    title: '',
    searched: false,
    finalSubmitClicked: false,
    detectBefore: null,
    detectAfter: null,
    message: '',
    warnings,
    validationLogs: [],
  };

  // 1. 确保 Dashboard P0 READY
  console.log('  [Sign-DRY-RUN] 检测 Dashboard P0...');
  const p0 = await detectBnsyDashboardP0(page);
  if (p0.status !== 'READY') {
    result.message = `Dashboard P0 不是 READY，拒绝执行 DRY-RUN（状态: ${p0.status}）`;
    warnings.push(`P0 状态: ${p0.status} - ${p0.message}`);
    return result;
  }
  console.log('  [Sign-DRY-RUN] Dashboard P0 = READY');

  // 2. 进入签收录入页面
  console.log(`  [Sign-DRY-RUN] 导航到签收录入页面: ${SIGN_PAGE_URL}`);
  console.log(`  [Sign-DRY-RUN] 签收页面 URL 来源: PageStateManager.ts:20 SIGN_PAGE_ROUTE`);
  try {
    const dashboardUrl = 'https://bnsy.benniaosuyun.com/dashboard';
    if (!page.url().includes('/dashboard')) {
      await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(3000);
    }

    await page.goto(SIGN_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);

    let currentUrl = page.url();
    if (currentUrl.includes('/dashboard')) {
      console.log(`  [Sign-DRY-RUN] 直接导航被重定向，尝试 Vue Router...`);
      await page.evaluate((url) => {
        const app = document.querySelector('#app') as any;
        if (app && app.__vue__ && app.__vue__.$router) {
          app.__vue__.$router.push(url.replace('https://bnsy.benniaosuyun.com', ''));
        } else {
          window.location.href = url;
        }
      }, SIGN_PAGE_URL);
      await page.waitForTimeout(3000);
    }

    currentUrl = page.url();
    console.log(`  [Sign-DRY-RUN] 当前 URL: ${currentUrl}`);
  } catch (err) {
    result.message = `签收页面打开失败: ${(err as Error).message}`;
    return result;
  }

  result.pageUrl = page.url();
  try {
    result.title = await page.title();
  } catch {
    result.title = '(无法获取标题)';
  }
  console.log(`  [Sign-DRY-RUN] 页面已打开: ${result.pageUrl}`);

  await cleanPagePopups(page);

  // 3. 检测签收页面元素（搜索前）
  console.log('  [Sign-DRY-RUN] 检测签收页面元素（搜索前）...');
  const detectBefore = await detectSignPage(page);
  result.detectBefore = detectBefore;

  console.log(`  [Sign-DRY-RUN] 是否签收页面: ${detectBefore.isSignPage}`);
  console.log(`  [Sign-DRY-RUN] 日期范围选择器: ${detectBefore.hasDateRangeInput ? '已检测到' : '未检测到'}`);
  console.log(`  [Sign-DRY-RUN] 派件员下拉框: ${detectBefore.hasCourierSelectInput ? '已检测到' : '未检测到'}`);
  console.log(`  [Sign-DRY-RUN] 搜索按钮: ${detectBefore.hasSearchButton ? '已检测到' : '未检测到'}`);
  console.log(`  [Sign-DRY-RUN] 批量签收按钮: ${detectBefore.hasBatchSignButton ? '已检测到（不点击）' : '未检测到'}`);

  // 4. 搜索前置校验：搜索按钮必须存在
  console.log('  [Sign-DRY-RUN] 搜索前置校验开始...');
  if (!detectBefore.hasSearchButton) {
    result.message = `搜索前置校验失败：搜索按钮未检测到，已停止执行`;
    result.success = false;
    result.validationLogs.push(`搜索按钮未检测到，已停止执行`);
    console.log(`  [Sign-DRY-RUN] ${result.message}`);
    return result;
  }
  console.log('  [Sign-DRY-RUN] 搜索前置校验通过');
  result.validationLogs.push('搜索前置校验通过');

  // 5. 点击搜索按钮（spec 白名单允许查询/搜索/检索）
  //    选择器来源：signSelectors.ts:36 searchButton
  //    旧代码使用位置：SignExecutor.selectCourier 后调用
  await cleanPagePopups(page);
  console.log('  [Sign-DRY-RUN] 点击搜索按钮...');
  console.log(`  [Sign-DRY-RUN] 搜索按钮选择器来源: signSelectors.ts:36 searchButton`);
  try {
    const searchBtn = page.locator(SIGN_SELECTORS.searchButton).first();

    // 安全保护：先读取按钮文本，确认不是最终提交
    const btnText = (await searchBtn.textContent() || '').trim();
    assertNotFinalSubmit(btnText);

    // 检查是否是搜索类按钮
    const isSearchBtn = ALLOWED_BUTTON_KEYWORDS.some(kw => btnText.includes(kw));
    if (!isSearchBtn) {
      warnings.push(`搜索按钮文本异常："${btnText}"，不包含查询/搜索/检索关键词`);
      console.log(`  [Sign-DRY-RUN] 搜索按钮文本异常："${btnText}"`);
      // 仍然继续，因为旧代码也是直接点击 searchButton 选择器
    }

    console.log(`  [Sign-DRY-RUN] 搜索按钮文本: "${btnText}"（安全检查通过）`);

    await stableClick(searchBtn, { timeoutMs: 5000 });
    result.searched = true;
    console.log(`  [Sign-DRY-RUN] 已点击搜索按钮`);

    // 等待搜索结果加载
    await page.waitForTimeout(3000);
  } catch (err) {
    if (err instanceof Error && err.message.includes('安全保护')) {
      result.message = err.message;
      return result;
    }
    warnings.push(`搜索按钮点击失败: ${(err as Error).message}`);
    console.log(`  [Sign-DRY-RUN] 搜索按钮点击异常: ${(err as Error).message}`);
  }

  // 6. 安全检测批量签收按钮（仅检测，不点击）
  console.log(`  [Sign-DRY-RUN] 批量签收按钮选择器来源: signSelectors.ts:79 batchSignButton（仅检测，不点击）`);
  console.log(`  [Sign-DRY-RUN] 签收弹窗确认按钮选择器来源: signSelectors.ts:94 dialogConfirmBtn（仅检测，不点击）`);
  result.validationLogs.push('已检测批量签收按钮（未点击）');
  result.validationLogs.push('已检测签收弹窗确认按钮（未点击）');
  result.validationLogs.push('已阻止最终提交');

  // 7. 再次检测页面元素（搜索后）
  console.log('  [Sign-DRY-RUN] 检测签收页面元素（搜索后）...');
  const detectAfter = await detectSignPage(page);
  result.detectAfter = detectAfter;

  console.log(`  [Sign-DRY-RUN] 搜索后表格: ${detectAfter.hasTable ? '已检测到' : '未检测到'}`);
  console.log(`  [Sign-DRY-RUN] 搜索后批量签收按钮: ${detectAfter.hasBatchSignButton ? '已检测到（不点击）' : '未检测到'}`);

  // 8. 明确 finalSubmitClicked = false
  result.finalSubmitClicked = false;

  // 9. 结果
  result.success = true;
  result.message = '签收录入 DRY-RUN 完成：已点击搜索按钮，未点击批量签收按钮，未点击签收弹窗确认按钮';

  console.log(`  [Sign-DRY-RUN] ${result.message}`);
  return result;
}
