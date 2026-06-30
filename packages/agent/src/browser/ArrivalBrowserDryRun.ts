/**
 * ArrivalBrowserDryRun — 到件扫描浏览器 DRY-RUN 页面操作
 *
 * Phase 5-D: 在笨鸟系统中执行到件扫描页面级 DRY-RUN。
 * Phase 5-E-1: 严格按旧执行流程代码的选择器，禁止猜测。
 *
 * 选择器来源：
 *   backend/operations/selectors/arrivalScanBatch.selectors.ts
 * 交互顺序来源：
 *   backend/operations/ArriveScanBatch.ts:178-225 (Step 7 上一站 + Step 8 查询)
 *
 * 硬性边界：
 *   - 禁止点击最终提交按钮（批量到件/确认到件/提交）
 *   - 只能点击查询/搜索类按钮
 *   - 不产生真实到件业务
 *   - 不处理真实生产单号
 */

import type { Page } from 'playwright-core';
import { detectArrivalPage, type ArrivalPageDetectResult } from './ArrivalPageDetector';
import { detectBnsyDashboardP0 } from './BnsyDashboardDetector';
import { stableFillTextarea, verifyInputValue, stableClick } from './StablePageActions';
import {
  ARRIVAL_BATCH_SELECTORS,
  DEFAULT_PREV_STATION,
  ARRIVAL_PAGE_ROUTE,
} from './arrivalSelectors';

export interface ArrivalBrowserDryRunInput {
  siteId: string;
  siteName: string;
  waybills: string[];
  options?: {
    prevStation?: string;
    batchSize?: number;
  };
}

export interface ArrivalBrowserDryRunResult {
  success: boolean;
  pageUrl: string;
  title: string;
  inputCount: number;
  queried: boolean;
  finalSubmitClicked: false;
  detectBefore: ArrivalPageDetectResult | null;
  detectAfter: ArrivalPageDetectResult | null;
  message: string;
  warnings: string[];
  /** Phase 5-E-1: 校验日志（供 Agent 上传） */
  validationLogs: string[];
}

// 到件扫描页面 URL（来源：PageStateManager.ts:18 ARRIVAL_PAGE_ROUTE）
const ARRIVAL_PAGE_URL = `https://bnsy.benniaosuyun.com${ARRIVAL_PAGE_ROUTE}`;

// 禁止点击的按钮关键词（用于 assertNotFinalSubmit 安全保护）
const FORBIDDEN_BUTTON_KEYWORDS = [
  '批量到件', '确认到件', '提交到件', '提交', '保存', '完成',
];

/**
 * 硬性保护：检查按钮文本是否是最终提交按钮
 * 来源：项目硬性约束（memory_item）
 * 如果疑似最终提交，直接抛错并停止
 */
function assertNotFinalSubmit(text: string): void {
  const normalized = text.replace(/\s+/g, '');
  for (const kw of FORBIDDEN_BUTTON_KEYWORDS) {
    if (normalized.includes(kw)) {
      throw new Error(`安全保护：禁止点击疑似最终提交按钮（文本: "${text}"，匹配关键词: "${kw}"）`);
    }
  }
}

/**
 * 清理页面上的阻塞弹窗（如余额不足提醒、公告等）
 * 只点击"取消"、"关闭"、"知道了"等安全按钮，不点击业务按钮
 *
 * 来源：旧流程 PopupManager，Agent 侧简化实现
 */
async function cleanPagePopups(page: Page): Promise<void> {
  try {
    const result = await page.evaluate(() => {
      let cleaned = 0;
      const actions: string[] = [];

      // 查找所有可见的 el-dialog__wrapper
      const wrappers = document.querySelectorAll('.el-dialog__wrapper');
      for (const wrapper of wrappers) {
        const ws = window.getComputedStyle(wrapper as HTMLElement);
        if (ws.display === 'none') continue;

        // 查找关闭/取消按钮
        const btns = wrapper.querySelectorAll('button');
        for (const btn of btns) {
          const text = (btn.textContent || '').replace(/\s+/g, '');
          // 只点击安全的关闭按钮
          if (text === '取消' || text === '关闭' || text === '知道了' || text === '确定' || text.includes('取消') || text.includes('关闭')) {
            // 安全检查：不点击包含禁止关键词的按钮
            if (text.includes('批量到件') || text.includes('确认到件') || text.includes('提交')) {
              continue;
            }
            (btn as HTMLElement).click();
            cleaned++;
            actions.push(`点击了"${text}"按钮`);
            break;
          }
        }
      }

      // 也清理 el-message-box
      const msgBoxes = document.querySelectorAll('.el-message-box__wrapper');
      for (const box of msgBoxes) {
        const ws = window.getComputedStyle(box as HTMLElement);
        if (ws.display === 'none') continue;
        const btns = box.querySelectorAll('button');
        for (const btn of btns) {
          const text = (btn.textContent || '').replace(/\s+/g, '');
          if (text === '取消' || text === '关闭' || text === '知道了' || text.includes('取消') || text.includes('关闭')) {
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
      console.log(`  [DRY-RUN] 弹窗清理: ${result.actions.join('; ')}`);
      await page.waitForTimeout(1000);
    }
  } catch {
    // 忽略清理失败
  }
}

/**
 * 执行到件扫描浏览器 DRY-RUN
 *
 * 选择器和交互流程严格遵循旧代码：
 *   - 运单 textarea：ARRIVAL_BATCH_SELECTORS.waybillTextarea
 *   - 上一站：ARRIVAL_BATCH_SELECTORS.prevStationInput + prevStationOption（el-select 下拉）
 *   - 查询按钮：ARRIVAL_BATCH_SELECTORS.queryBtn
 *   - 最终提交按钮：ARRIVAL_BATCH_SELECTORS.submitBatchBtn（仅检测，绝不点击）
 */
export async function runArrivalBrowserDryRun(
  page: Page,
  input: ArrivalBrowserDryRunInput,
): Promise<ArrivalBrowserDryRunResult> {
  const warnings: string[] = [];
  const { waybills, options } = input;
  const prevStation = options?.prevStation || DEFAULT_PREV_STATION;

  const result: ArrivalBrowserDryRunResult = {
    success: false,
    pageUrl: '',
    title: '',
    inputCount: 0,
    queried: false,
    finalSubmitClicked: false,
    detectBefore: null,
    detectAfter: null,
    message: '',
    warnings,
    validationLogs: [],
  };

  // 1. 确保 Dashboard P0 READY
  console.log('  [DRY-RUN] 检测 Dashboard P0...');
  const p0 = await detectBnsyDashboardP0(page);
  if (p0.status !== 'READY') {
    result.message = `Dashboard P0 不是 READY，拒绝执行 DRY-RUN（状态: ${p0.status}）`;
    warnings.push(`P0 状态: ${p0.status} - ${p0.message}`);
    return result;
  }
  console.log('  [DRY-RUN] Dashboard P0 = READY');

  // 2. 进入到件扫描页面
  console.log(`  [DRY-RUN] 导航到到件扫描页面: ${ARRIVAL_PAGE_URL}`);
  console.log(`  [DRY-RUN] 到件页面 URL 来源: PageStateManager.ts:18 ARRIVAL_PAGE_ROUTE`);
  try {
    // 先确保在 dashboard，等待 SPA 完全初始化
    const dashboardUrl = 'https://bnsy.benniaosuyun.com/dashboard';
    if (!page.url().includes('/dashboard')) {
      await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(3000);
    }

    // 导航到到件扫描页面
    await page.goto(ARRIVAL_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);

    // 检查是否被重定向到 dashboard
    let currentUrl = page.url();
    if (currentUrl.includes('/dashboard')) {
      console.log(`  [DRY-RUN] 直接导航被重定向，尝试 Vue Router...`);
      // 通过 Vue Router 导航
      await page.evaluate((url) => {
        const app = document.querySelector('#app') as any;
        if (app && app.__vue__ && app.__vue__.$router) {
          app.__vue__.$router.push(url.replace('https://bnsy.benniaosuyun.com', ''));
        } else {
          window.location.href = url;
        }
      }, ARRIVAL_PAGE_URL);
      await page.waitForTimeout(3000);
    }

    currentUrl = page.url();
    console.log(`  [DRY-RUN] 当前 URL: ${currentUrl}`);
  } catch (err) {
    result.message = `到件页面打开失败: ${(err as Error).message}`;
    return result;
  }

  result.pageUrl = page.url();
  try {
    result.title = await page.title();
  } catch {
    result.title = '(无法获取标题)';
    console.log(`  [DRY-RUN] page.title() 失败，可能是页面正在重载，继续执行`);
  }
  console.log(`  [DRY-RUN] 页面已打开: ${result.pageUrl}`);
  console.log(`  [DRY-RUN] 页面标题: ${result.title}`);

  // 2b. 清理页面上的阻塞弹窗（如余额不足提醒）
  await cleanPagePopups(page);

  // 3. 检测到件页面元素（查询前）
  console.log('  [DRY-RUN] 检测到件页面元素（查询前）...');
  const detectBefore = await detectArrivalPage(page);
  result.detectBefore = detectBefore;

  console.log(`  [DRY-RUN] 是否到件页面: ${detectBefore.isArrivalPage}`);
  console.log(`  [DRY-RUN] 运单输入框: ${detectBefore.hasWaybillInput ? '已检测到' : '未检测到'}`);
  console.log(`  [DRY-RUN] 上一站输入框: ${detectBefore.hasPrevStationInput ? '已检测到' : '未检测到'}`);
  console.log(`  [DRY-RUN] 查询按钮: ${detectBefore.hasSearchButton ? '已检测到' : '未检测到'}`);
  console.log(`  [DRY-RUN] 结果表格: ${detectBefore.hasTable ? '已检测到' : '未检测到'}`);
  console.log(`  [DRY-RUN] 最终提交按钮: ${detectBefore.hasFinalSubmitButton ? '已检测到（不点击）' : '未检测到'}`);

  if (!detectBefore.isArrivalPage) {
    warnings.push('当前页面不是到件扫描页面');
  }
  if (!detectBefore.hasWaybillInput) {
    warnings.push('未检测到运单输入框');
  }
  if (!detectBefore.hasSearchButton) {
    warnings.push('未检测到查询按钮');
  }

  // ────────────────────────────────────────────────────────────
  // 4. 稳定输入测试运单
  //    选择器来源：arrivalScanBatch.selectors.ts:42-43 waybillTextarea
  //    旧代码使用位置：ArriveScanBatch.ts:158, 162-176
  // ────────────────────────────────────────────────────────────
  let waybillInputSuccess = false;
  if (detectBefore.hasWaybillInput && waybills.length > 0) {
    console.log(`  [DRY-RUN] 稳定输入测试运单 (${waybills.length} 条)...`);
    console.log(`  [DRY-RUN] 运单 textarea 选择器来源: arrivalScanBatch.selectors.ts:42-43`);
    try {
      const textareaLocator = page.locator(ARRIVAL_BATCH_SELECTORS.waybillTextarea).first();
      if (await textareaLocator.isVisible({ timeout: 5000 })) {
        await stableFillTextarea(textareaLocator, waybills.join('\n'), { maxRetries: 3 });
        result.inputCount = waybills.length;
        waybillInputSuccess = true;
        console.log(`  [DRY-RUN] 运单输入校验通过：${waybills.length} 条`);
        result.validationLogs.push(`运单输入校验通过：${waybills.length} 条`);
      } else {
        warnings.push('运单输入框不可见');
        console.log(`  [DRY-RUN] 运单输入校验失败：textarea 不可见`);
      }
    } catch (err) {
      warnings.push(`运单输入失败: ${(err as Error).message}`);
      console.log(`  [DRY-RUN] 运单输入异常: ${(err as Error).message}`);
    }
  }

  // ────────────────────────────────────────────────────────────
  // 5. 稳定填写上一站
  //    选择器来源：
  //      - prevStationInput: arrivalScanBatch.selectors.ts:46-47
  //      - prevStationOption: arrivalScanBatch.selectors.ts:49-50
  //    交互顺序来源：ArriveScanBatch.ts:178-200 (Step 7)
  //    真实交互：
  //      1. page.click(prevStationInput)
  //      2. waitForTimeout(800)
  //      3. locator(prevStationOption).count()
  //      4. 若 count > 0：prevOptionLoc.first().click() + waitForTimeout(500)
  //      5. 否则兜底：page.fill(prevStationInput, DEFAULT_PREV_STATION) + keyboard.press('Enter')
  // ────────────────────────────────────────────────────────────
  let prevStationSuccess = false;
  if (detectBefore.hasPrevStationInput && prevStation) {
    console.log(`  [DRY-RUN] 上一站填写开始：${prevStation}`);
    console.log(`  [DRY-RUN] 上一站 input 选择器来源: arrivalScanBatch.selectors.ts:46-47`);
    console.log(`  [DRY-RUN] 上一站 option 选择器来源: arrivalScanBatch.selectors.ts:49-50`);
    console.log(`  [DRY-RUN] 上一站交互方式: 点击 input → 等 800ms → 选择下拉候选 → 校验 value`);
    result.validationLogs.push(`上一站填写开始：${prevStation}`);
    try {
      prevStationSuccess = await stableFillPrevStation(page, prevStation);
      if (prevStationSuccess) {
        console.log(`  [DRY-RUN] 上一站填写校验通过：${prevStation}`);
        result.validationLogs.push(`上一站填写校验通过：${prevStation}`);
      } else {
        console.log(`  [DRY-RUN] 上一站填写失败：未确认选中"${prevStation}"`);
      }
    } catch (err) {
      console.log(`  [DRY-RUN] 上一站填写异常: ${(err as Error).message}`);
    }

    if (!prevStationSuccess) {
      warnings.push(`上一站填写失败：未确认选中"${prevStation}"`);
    }
  }

  // ────────────────────────────────────────────────────────────
  // 6. 查询前置校验：必须全部通过才能点击查询
  //    失败任意一项 → 任务 failed，不点击查询
  // ────────────────────────────────────────────────────────────
  console.log('  [DRY-RUN] 查询前置校验开始...');
  const preQueryChecks = {
    waybill: waybillInputSuccess,
    prevStation: prevStationSuccess,
    searchButton: detectBefore.hasSearchButton,
  };
  console.log(`  [DRY-RUN] 校验结果：运单=${preQueryChecks.waybill}，上一站=${preQueryChecks.prevStation}，查询按钮=${preQueryChecks.searchButton}`);

  if (!preQueryChecks.waybill || !preQueryChecks.prevStation || !preQueryChecks.searchButton) {
    const failedParts: string[] = [];
    if (!preQueryChecks.waybill) failedParts.push('运单输入');
    if (!preQueryChecks.prevStation) failedParts.push('上一站填写');
    if (!preQueryChecks.searchButton) failedParts.push('查询按钮检测');
    result.message = `查询前置校验失败：${failedParts.join('、')}未通过，已停止执行，未点击查询`;
    result.success = false;
    result.validationLogs.push(`上一站填写失败，已停止执行，未点击查询`);
    console.log(`  [DRY-RUN] ${result.message}`);
    return result;
  }
  console.log('  [DRY-RUN] 查询前置校验通过');
  result.validationLogs.push('查询前置校验通过');

  // ────────────────────────────────────────────────────────────
  // 7. 点击查询按钮
  //    选择器来源：arrivalScanBatch.selectors.ts:53-54 queryBtn
  //    旧代码使用位置：ArriveScanBatch.ts:206
  //    安全保护：点击前再次 assertNotFinalSubmit
  // ────────────────────────────────────────────────────────────
  await cleanPagePopups(page);
  console.log('  [DRY-RUN] 点击查询按钮...');
  console.log(`  [DRY-RUN] 查询按钮选择器来源: arrivalScanBatch.selectors.ts:53-54`);
  try {
    const queryBtn = page.locator(ARRIVAL_BATCH_SELECTORS.queryBtn).first();

    // 安全保护：先读取按钮文本，确认不是最终提交
    const btnText = (await queryBtn.textContent() || '').trim();
    assertNotFinalSubmit(btnText);
    console.log(`  [DRY-RUN] 查询按钮文本: "${btnText}"（安全检查通过）`);

    // 等待可见并点击
    await stableClick(queryBtn, { timeoutMs: 5000 });
    result.queried = true;
    console.log(`  [DRY-RUN] 已点击查询按钮`);

    // 等待查询结果（旧代码 ArriveScanBatch.ts:207 waitForTimeout(3000)）
    await page.waitForTimeout(3000);

    // 旧代码 ArriveScanBatch.ts:211 等待表格行可见
    try {
      await page.waitForSelector('.el-table__body-wrapper .el-table__row', {
        timeout: 8000,
        state: 'visible',
      });
      console.log(`  [DRY-RUN] 查询结果表格行已加载`);
    } catch {
      warnings.push('查询后表格行未加载（可能运单号是测试号，无数据属正常）');
      console.log(`  [DRY-RUN] 查询结果表格行未加载（测试运单号无数据，属正常）`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('安全保护')) {
      result.message = err.message;
      return result;
    }
    warnings.push(`查询按钮点击失败: ${(err as Error).message}`);
    console.log(`  [DRY-RUN] 查询按钮点击异常: ${(err as Error).message}`);
  }

  // 8. 再次检测到件页面元素（查询后）
  console.log('  [DRY-RUN] 检测到件页面元素（查询后）...');
  const detectAfter = await detectArrivalPage(page);
  result.detectAfter = detectAfter;

  console.log(`  [DRY-RUN] 查询后表格: ${detectAfter.hasTable ? '已检测到' : '未检测到'}`);
  console.log(`  [DRY-RUN] 查询后提交按钮: ${detectAfter.hasFinalSubmitButton ? '已检测到（不点击）' : '未检测到'}`);

  // 9. 明确 finalSubmitClicked = false
  result.finalSubmitClicked = false;
  result.validationLogs.push('已阻止最终提交');

  // 10. 结果
  result.success = true;
  result.message = 'DRY-RUN 完成：已输入运单并点击查询，未点击最终提交按钮';

  console.log(`  [DRY-RUN] ${result.message}`);
  return result;
}

// ══════════════════════════════════════════════════════════
// 稳定填写上一站
//
// 严格遵循旧代码 ArriveScanBatch.ts:178-200 (Step 7) 的交互顺序：
//   1. page.click(ARRIVAL_BATCH_SELECTORS.prevStationInput, { timeout: 10000 })
//   2. page.waitForTimeout(800)
//   3. prevOptionLoc = page.locator(ARRIVAL_BATCH_SELECTORS.prevStationOption)
//   4. if (count > 0) { prevOptionLoc.first().click(); waitForTimeout(500); }
//   5. else { fill(prevStationInput, prevStation); keyboard.press('Enter'); }
//
// 选择器来源：
//   - prevStationInput: arrivalScanBatch.selectors.ts:46-47
//   - prevStationOption: arrivalScanBatch.selectors.ts:49-50
// ══════════════════════════════════════════════════════════

/**
 * 稳定填写上一站
 *
 * @returns true=成功，false=失败
 */
async function stableFillPrevStation(page: Page, prevStation: string): Promise<boolean> {
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`  [DRY-RUN] 上一站填写第 ${attempt} 次尝试...`);

    try {
      // Step 7.1: 点击 prevStationInput（旧代码 ArriveScanBatch.ts:182）
      const prevInput = page.locator(ARRIVAL_BATCH_SELECTORS.prevStationInput).first();
      await prevInput.waitFor({ state: 'visible', timeout: 10_000 });
      await prevInput.click({ timeout: 10_000 });
      console.log(`  [DRY-RUN] 已点击上一站 input`);

      // Step 7.2: 等待下拉浮层出现（旧代码 ArriveScanBatch.ts:183）
      await page.waitForTimeout(800);

      // Step 7.3: 定位候选项（旧代码 ArriveScanBatch.ts:185-188）
      // prevStationOption 是 body 下的浮层，不在 #app 内
      const prevOptionLoc = page.locator(ARRIVAL_BATCH_SELECTORS.prevStationOption);
      const prevCount = await prevOptionLoc.count();
      console.log(`  [DRY-RUN] 候选项数量: ${prevCount}`);

      if (prevCount > 0) {
        // Step 7.4a: 候选项存在 → 点击第一个（旧代码 ArriveScanBatch.ts:188）
        await prevOptionLoc.first().click({ timeout: 5000 });
        await page.waitForTimeout(500);
        console.log(`  [DRY-RUN] 已点击候选项`);
      } else {
        // Step 7.4b: 兜底 → 直接 fill + Enter（旧代码 ArriveScanBatch.ts:193-195）
        console.log(`  [DRY-RUN] 未找到候选项，使用兜底策略：fill + Enter`);
        await prevInput.fill(prevStation, { timeout: 5000 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
      }

      // 校验：读取 input value 或周围 el-tag 文本，确认包含 prevStation
      const verified = await verifyPrevStationSelected(page, prevStation);
      if (verified) {
        console.log(`  [DRY-RUN] 上一站校验通过（第 ${attempt} 次）`);
        return true;
      }

      // 校验失败：关闭可能残留的下拉浮层，再重试
      console.log(`  [DRY-RUN] 上一站校验失败（第 ${attempt} 次），准备重试`);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
    } catch (err) {
      console.log(`  [DRY-RUN] 上一站填写第 ${attempt} 次异常: ${(err as Error).message}`);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
    }

    if (attempt < MAX_RETRIES) {
      await page.waitForTimeout(500);
    }
  }

  return false;
}

/**
 * 校验上一站是否成功选中
 *
 * Element el-select 选中后，可能有两种表现：
 *   1. input.value 直接为选中文本（普通模式）
 *   2. input.value 为空，但显示 el-tag（多选/远程模式）
 *
 * 校验策略：
 *   - 先读 input.value，若包含 prevStation → 通过
 *   - 否则查找 el-select__tags 或 .el-tag，若包含 prevStation → 通过
 *   - 否则失败
 */
async function verifyPrevStationSelected(page: Page, prevStation: string): Promise<boolean> {
  try {
    // 1. 读取 input.value
    const inputValue = await page.locator(ARRIVAL_BATCH_SELECTORS.prevStationInput).first()
      .inputValue().catch(() => '');
    if (inputValue.includes(prevStation)) {
      console.log(`  [DRY-RUN] 上一站 input.value 校验通过: "${inputValue}"`);
      return true;
    }

    // 2. 检查 el-tag 文本（Element 多选/复杂模式）
    const tagText = await page.evaluate((search: string) => {
      // prevStationInput 选择器中的 input 父级是 el-select
      const tags = document.querySelectorAll(
        '#app .el-input.el-input--medium.el-input--suffix .el-select__tags-text, ' +
        '#app .el-select .el-tag, ' +
        '#app .el-input.el-input--medium.el-input--suffix + .el-tag'
      );
      for (const tag of tags) {
        const text = (tag.textContent || '').trim();
        if (text.includes(search)) return text;
      }
      return '';
    }, prevStation).catch(() => '');

    if (tagText.includes(prevStation)) {
      console.log(`  [DRY-RUN] 上一站 el-tag 校验通过: "${tagText}"`);
      return true;
    }

    // 3. 校验失败
    console.log(`  [DRY-RUN] 上一站校验失败：input="${inputValue}"，tag="${tagText}"`);
    return false;
  } catch {
    return false;
  }
}
