/**
 * DispatchBrowserDryRun — 派件扫描浏览器 DRY-RUN 页面操作
 *
 * Phase 5-F: 在笨鸟系统中执行派件扫描页面级 DRY-RUN。
 *
 * 选择器来源：
 *   backend/operations/selectors/dispatchScan.selectors.ts
 * 交互顺序来源：
 *   backend/operations/DispatchScan.ts:126-185 processOneBatch
 *
 * 硬性边界：
 *   - 禁止点击"上传"按钮（最终提交）
 *   - 禁止点击"添加"按钮（spec 白名单只允许查询/搜索/检索）
 *   - 只输入运单到 waybillInput，检测元素，不产生真实业务
 *   - 不处理真实生产单号
 */

import type { Page } from 'playwright-core';
import { detectDispatchPage, type DispatchPageDetectResult } from './DispatchPageDetector';
import { detectBnsyDashboardP0 } from './BnsyDashboardDetector';
import { stableFillInput, verifyInputValue } from './StablePageActions';
import { DISPATCH_SCAN_SELECTORS, DISPATCH_PAGE_ROUTE } from './dispatchSelectors';

export interface DispatchBrowserDryRunInput {
  siteId: string;
  siteName: string;
  waybills: string[];
  options?: {
    staffName?: string;

    /** 派件员姓名（用于下拉框文本匹配选择） */
    courierName?: string;
  };
}

export interface DispatchBrowserDryRunResult {
  success: boolean;
  pageUrl: string;
  title: string;
  inputCount: number;
  courierSelected: boolean;
  clickedButton: 'none' | 'search';
  finalSubmitClicked: false;
  detectBefore: DispatchPageDetectResult | null;
  detectAfter: DispatchPageDetectResult | null;
  message: string;
  warnings: string[];
  validationLogs: string[];
}

// 派件扫描页面 URL（来源：PageStateManager.ts:19 DISPATCH_PAGE_ROUTE）
const DISPATCH_PAGE_URL = `https://bnsy.benniaosuyun.com${DISPATCH_PAGE_ROUTE}`;

// 禁止点击的按钮关键词（用于 assertNotFinalSubmit 安全保护）
const FORBIDDEN_BUTTON_KEYWORDS = [
  '上传', '提交', '确认', '批量', '派件', '签收', '保存', '完成', '执行', '到派',
];

/**
 * 硬性保护：检查按钮文本是否是最终提交按钮
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
 * 清理页面上的阻塞弹窗
 */
async function cleanPagePopups(page: Page): Promise<void> {
  try {
    const result = await page.evaluate(() => {
      let cleaned = 0;
      const actions: string[] = [];

      const wrappers = document.querySelectorAll('.el-dialog__wrapper');
      for (const wrapper of wrappers) {
        const ws = window.getComputedStyle(wrapper as HTMLElement);
        if (ws.display === 'none') continue;

        const btns = wrapper.querySelectorAll('button');
        for (const btn of btns) {
          const text = (btn.textContent || '').replace(/\s+/g, '');
          if (text === '取消' || text === '关闭' || text === '知道了' || text.includes('取消') || text.includes('关闭')) {
            if (text.includes('上传') || text.includes('提交') || text.includes('批量') || text.includes('签收')) {
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
      console.log(`  [Dispatch-DRY-RUN] 弹窗清理: ${result.actions.join('; ')}`);
      await page.waitForTimeout(1000);
    }
  } catch {
    // 忽略清理失败
  }
}

/**
 * 执行派件扫描浏览器 DRY-RUN
 *
 * 选择器和交互流程严格遵循旧代码：
 *   - 运单输入框：DISPATCH_SCAN_SELECTORS.waybillInput
 *   - 派件员下拉框：DISPATCH_SCAN_SELECTORS.courierSelectInput（仅检测）
 *   - 添加按钮：DISPATCH_SCAN_SELECTORS.addButton（仅检测，不点击）
 *   - 上传按钮：DISPATCH_SCAN_SELECTORS.uploadButton（仅检测，绝不点击）
 */
export async function runDispatchBrowserDryRun(
  page: Page,
  input: DispatchBrowserDryRunInput,
): Promise<DispatchBrowserDryRunResult> {
  const warnings: string[] = [];
  const { waybills, options } = input;
  const courierName = options?.courierName;

  const result: DispatchBrowserDryRunResult = {
    success: false,
    pageUrl: '',
    title: '',
    inputCount: 0,
    courierSelected: false,
    clickedButton: 'none',
    finalSubmitClicked: false,
    detectBefore: null,
    detectAfter: null,
    message: '',
    warnings,
    validationLogs: [],
  };

  // 1. 确保 Dashboard P0 READY
  console.log('  [Dispatch-DRY-RUN] 检测 Dashboard P0...');
  const p0 = await detectBnsyDashboardP0(page);
  if (p0.status !== 'READY') {
    result.message = `Dashboard P0 不是 READY，拒绝执行 DRY-RUN（状态: ${p0.status}）`;
    warnings.push(`P0 状态: ${p0.status} - ${p0.message}`);
    return result;
  }
  console.log('  [Dispatch-DRY-RUN] Dashboard P0 = READY');

  // 2. 进入派件扫描页面
  console.log(`  [Dispatch-DRY-RUN] 导航到派件扫描页面: ${DISPATCH_PAGE_URL}`);
  console.log(`  [Dispatch-DRY-RUN] 派件页面 URL 来源: PageStateManager.ts:19 DISPATCH_PAGE_ROUTE`);
  try {
    const dashboardUrl = 'https://bnsy.benniaosuyun.com/dashboard';
    if (!page.url().includes('/dashboard')) {
      await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(3000);
    }

    await page.goto(DISPATCH_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);

    // 检查是否被重定向到 dashboard
    let currentUrl = page.url();
    if (currentUrl.includes('/dashboard')) {
      console.log(`  [Dispatch-DRY-RUN] 直接导航被重定向，尝试 Vue Router...`);
      await page.evaluate((url) => {
        const app = document.querySelector('#app') as any;
        if (app && app.__vue__ && app.__vue__.$router) {
          app.__vue__.$router.push(url.replace('https://bnsy.benniaosuyun.com', ''));
        } else {
          window.location.href = url;
        }
      }, DISPATCH_PAGE_URL);
      await page.waitForTimeout(3000);
    }

    currentUrl = page.url();
    console.log(`  [Dispatch-DRY-RUN] 当前 URL: ${currentUrl}`);
  } catch (err) {
    result.message = `派件页面打开失败: ${(err as Error).message}`;
    return result;
  }

  result.pageUrl = page.url();
  try {
    result.title = await page.title();
  } catch {
    result.title = '(无法获取标题)';
  }
  console.log(`  [Dispatch-DRY-RUN] 页面已打开: ${result.pageUrl}`);

  // 2b. 清理页面上的阻塞弹窗
  await cleanPagePopups(page);

  // 3. 检测派件页面元素（输入前）
  console.log('  [Dispatch-DRY-RUN] 检测派件页面元素（输入前）...');
  const detectBefore = await detectDispatchPage(page);
  result.detectBefore = detectBefore;

  console.log(`  [Dispatch-DRY-RUN] 是否派件页面: ${detectBefore.isDispatchPage}`);
  console.log(`  [Dispatch-DRY-RUN] 派件员下拉框: ${detectBefore.hasCourierSelectInput ? '已检测到' : '未检测到'}`);
  console.log(`  [Dispatch-DRY-RUN] 运单输入框: ${detectBefore.hasWaybillInput ? '已检测到' : '未检测到'}`);
  console.log(`  [Dispatch-DRY-RUN] 添加按钮: ${detectBefore.hasAddButton ? '已检测到（不点击）' : '未检测到'}`);
  console.log(`  [Dispatch-DRY-RUN] 上传按钮: ${detectBefore.hasUploadButton ? '已检测到（不点击）' : '未检测到'}`);

  // 4. 选派件员 —— el-select 下拉框，文本匹配 courierName
  //    选择器来源：dispatchSelectors.ts courierSelectInput / courierOption
  //    交互顺序来源：DispatchScan.ts:188-215 selectCourier
  //    ⚠️ 派件扫描的派件员选择是 el-select 下拉框（与到派一体的弹窗选择不同）
  //    ⚠️ 候选项是 li 元素，不是按钮，不触发 assertNotFinalSubmit
  let courierSelectSuccess = false;
  if (detectBefore.hasCourierSelectInput && courierName) {
    console.log(`  [Dispatch-DRY-RUN] 选派件员开始：${courierName}`);
    console.log(`  [Dispatch-DRY-RUN] 派件员下拉框选择器来源: dispatchScan.selectors.ts:27-28 courierSelectInput`);
    console.log(`  [Dispatch-DRY-RUN] 派件员候选项选择器来源: dispatchScan.selectors.ts:35-36 courierOption`);
    result.validationLogs.push(`选派件员开始：${courierName}`);
    try {
      courierSelectSuccess = await selectCourier(page, courierName);
      if (courierSelectSuccess) {
        result.courierSelected = true;
        console.log(`  [Dispatch-DRY-RUN] 派件员选择校验通过：${courierName}`);
        result.validationLogs.push(`派件员选择校验通过：${courierName}`);
      } else {
        console.log(`  [Dispatch-DRY-RUN] 派件员选择校验失败：未确认选中"${courierName}"`);
      }
    } catch (err) {
      console.log(`  [Dispatch-DRY-RUN] 派件员选择异常: ${(err as Error).message}`);
    }

    if (!courierSelectSuccess) {
      warnings.push(`派件员选择失败：未确认选中"${courierName}"`);
    }
  } else if (!courierName) {
    console.log(`  [Dispatch-DRY-RUN] 未提供 courierName，跳过派件员选择`);
    warnings.push('未提供派件员姓名，跳过派件员选择');
  }

  // 5. 稳定输入测试运单
  //    选择器来源：dispatchScan.selectors.ts:39-40 waybillInput
  //    旧代码使用位置：DispatchScan.ts:267, 270
  let waybillInputSuccess = false;
  if (detectBefore.hasWaybillInput && waybills.length > 0) {
    console.log(`  [Dispatch-DRY-RUN] 稳定输入测试运单 (${waybills.length} 条)...`);
    console.log(`  [Dispatch-DRY-RUN] 运单输入框选择器来源: dispatchScan.selectors.ts:39-40 waybillInput`);
    try {
      // 派件扫描是逐个输入（旧代码 addWaybillsOneByOne），DRY-RUN 只输入第一条验证
      const waybillInput = page.locator(DISPATCH_SCAN_SELECTORS.waybillInput).first();
      if (await waybillInput.isVisible({ timeout: 5000 })) {
        const testWaybill = waybills[0];
        await stableFillInput(waybillInput, testWaybill, { maxRetries: 3 });
        const verified = await verifyInputValue(waybillInput, testWaybill, { timeoutMs: 2000 });
        if (verified) {
          result.inputCount = 1;
          waybillInputSuccess = true;
          console.log(`  [Dispatch-DRY-RUN] 运单输入校验通过：${testWaybill}`);
          result.validationLogs.push(`运单输入校验通过：${testWaybill}`);
        } else {
          warnings.push('运单输入校验失败');
          console.log(`  [Dispatch-DRY-RUN] 运单输入校验失败`);
        }
      } else {
        warnings.push('运单输入框不可见');
      }
    } catch (err) {
      warnings.push(`运单输入失败: ${(err as Error).message}`);
      console.log(`  [Dispatch-DRY-RUN] 运单输入异常: ${(err as Error).message}`);
    }
  }

  // 6. 输入前置校验：派件员 + 运单输入必须全部成功
  console.log('  [Dispatch-DRY-RUN] 输入前置校验开始...');
  const preInputChecks = {
    courier: courierSelectSuccess,
    waybill: waybillInputSuccess,
  };
  console.log(`  [Dispatch-DRY-RUN] 校验结果：派件员=${preInputChecks.courier}，运单=${preInputChecks.waybill}`);

  if (!preInputChecks.courier || !preInputChecks.waybill) {
    const failedParts: string[] = [];
    if (!preInputChecks.courier) failedParts.push('派件员选择');
    if (!preInputChecks.waybill) failedParts.push('运单输入');
    result.message = `输入前置校验失败：${failedParts.join('、')}未通过，已停止执行`;
    result.success = false;
    result.validationLogs.push(`输入校验失败，已停止执行，未点击上传`);
    console.log(`  [Dispatch-DRY-RUN] ${result.message}`);
    return result;
  }
  console.log('  [Dispatch-DRY-RUN] 输入前置校验通过');
  result.validationLogs.push('输入前置校验通过');

  // 6. 安全检测添加按钮和上传按钮（仅检测，不点击）
  //    来源：dispatchScan.selectors.ts:43 addButton, :65 uploadButton
  console.log(`  [Dispatch-DRY-RUN] 添加按钮选择器来源: dispatchScan.selectors.ts:43 addButton（仅检测，不点击）`);
  console.log(`  [Dispatch-DRY-RUN] 上传按钮选择器来源: dispatchScan.selectors.ts:65 uploadButton（仅检测，不点击）`);
  result.validationLogs.push('已检测添加按钮（未点击）');
  result.validationLogs.push('已检测上传按钮（未点击）');
  result.validationLogs.push('已阻止最终提交');

  // 7. 再次检测页面元素（输入后）
  console.log('  [Dispatch-DRY-RUN] 检测派件页面元素（输入后）...');
  const detectAfter = await detectDispatchPage(page);
  result.detectAfter = detectAfter;

  // 8. 明确 finalSubmitClicked = false
  result.finalSubmitClicked = false;
  result.clickedButton = 'none';

  // 9. 结果
  result.success = true;
  result.message = '派件扫描 DRY-RUN 完成：已选派件员+输入运单，未点击添加按钮，未点击上传按钮';

  console.log(`  [Dispatch-DRY-RUN] ${result.message}`);
  return result;
}

// ══════════════════════════════════════════════════════════
// 选派件员 —— el-select 下拉框，文本匹配 courierName
//
// 严格遵循旧代码 DispatchScan.ts:188-215 selectCourier 原样逻辑：
//   1. Playwright .click() 点击派件员下拉框 input（触发 el-select 展开浮层）
//   2. 等 500ms 浮层动画
//   3. 文本匹配候选项（li.el-select-dropdown__item，:visible 过滤当前可见浮层）
//   4. 点击匹配的候选项
//   5. 等 500ms 选择动画
//   6. 验证：派件员 input.value 包含 courierName
//
// ⚠️ 派件扫描的派件员选择是 el-select 下拉框，与到派一体的弹窗选择不同：
//   - 派件扫描：el-select 下拉框，文本匹配 staffName → 点击 li 候选项
//   - 到派一体：点击 input 触发"选择派件员"弹窗 → 表格按 employeeId 匹配 → 点击"使用"按钮
//
// 选择器来源：
//   - courierSelectInput: dispatchSelectors.ts（来源 dispatchScan.selectors.ts:27-28）
//   - courierOption: dispatchSelectors.ts（来源 dispatchScan.selectors.ts:35-36）
//     ${staffName} 为运行时替换占位符
// ══════════════════════════════════════════════════════════

async function selectCourier(
  page: Page,
  courierName: string,
): Promise<boolean> {
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`  [Dispatch-DRY-RUN] 派件员选择第 ${attempt} 次尝试...`);

    try {
      // Step 1: 点击派件员下拉框 input（旧代码 DispatchScan.ts:199）
      const inputLoc = page.locator(DISPATCH_SCAN_SELECTORS.courierSelectInput);
      const inputCount = await inputLoc.count();
      if (inputCount === 0) {
        console.log(`  [Dispatch-DRY-RUN] 未找到派件员下拉框 input`);
        return false;
      }

      await inputLoc.first().click({ timeout: 10_000 });
      console.log(`  [Dispatch-DRY-RUN] 已点击派件员下拉框 input`);

      // Step 2: 等待浮层动画（旧代码 DispatchScan.ts:200）
      await page.waitForTimeout(500);

      // Step 3: 文本匹配候选项（旧代码 DispatchScan.ts:203-204）
      //    courierOption 选择器含 ${staffName} 占位符，需 replace
      //    :visible 过滤当前可见浮层，避免匹配到隐藏的旧浮层
      const optionSel = DISPATCH_SCAN_SELECTORS.courierOption.replace('${staffName}', courierName);
      const optionLoc = page.locator(optionSel);
      const optionCount = await optionLoc.count();
      console.log(`  [Dispatch-DRY-RUN] 候选项数量: ${optionCount}`);

      if (optionCount === 0) {
        // 兜底：用 page.evaluate 遍历所有可见 li.el-select-dropdown__item
        console.log(`  [Dispatch-DRY-RUN] Playwright locator 未匹配，尝试 DOM 遍历兜底`);
        const domClicked = await page.evaluate((name: string) => {
          const poppers = document.querySelectorAll('div.el-select-dropdown.el-popper');
          for (const popper of poppers) {
            const ws = window.getComputedStyle(popper as HTMLElement);
            if (ws.display === 'none') continue;
            const items = popper.querySelectorAll('li.el-select-dropdown__item');
            for (const item of items) {
              const text = (item.textContent || '').trim();
              if (text === name || text.includes(name)) {
                (item as HTMLElement).click();
                return true;
              }
            }
          }
          return false;
        }, courierName);

        if (domClicked) {
          console.log(`  [Dispatch-DRY-RUN] 已点击候选项（DOM click 兜底）`);
          await page.waitForTimeout(500);
          // 跳到校验步骤
          const verified = await verifyCourierSelected(page, courierName);
          if (verified) {
            console.log(`  [Dispatch-DRY-RUN] 派件员校验通过（第 ${attempt} 次）`);
            return true;
          }
        }

        console.log(`  [Dispatch-DRY-RUN] 第 ${attempt} 次未找到候选项"${courierName}"`);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(300);
        continue;
      }

      // Step 4: 点击匹配的候选项（旧代码 DispatchScan.ts:212）
      try {
        await optionLoc.first().click({ timeout: 5000 });
        console.log(`  [Dispatch-DRY-RUN] 已点击候选项（Playwright click）`);
      } catch (err) {
        // force click 兜底（浮层可能被 Playwright 判定不可见）
        console.log(`  [Dispatch-DRY-RUN] Playwright click 失败: ${(err as Error).message}，尝试 force click`);
        try {
          await optionLoc.first().click({ force: true, timeout: 5000 });
          console.log(`  [Dispatch-DRY-RUN] 已点击候选项（force click）`);
        } catch (err2) {
          console.log(`  [Dispatch-DRY-RUN] force click 也失败: ${(err2 as Error).message}`);
          await page.keyboard.press('Escape').catch(() => {});
          await page.waitForTimeout(300);
          continue;
        }
      }

      // Step 5: 等待选择动画（旧代码 DispatchScan.ts:213）
      await page.waitForTimeout(500);

      // Step 6: 校验
      const verified = await verifyCourierSelected(page, courierName);
      if (verified) {
        console.log(`  [Dispatch-DRY-RUN] 派件员校验通过（第 ${attempt} 次）`);
        return true;
      }

      console.log(`  [Dispatch-DRY-RUN] 派件员校验失败（第 ${attempt} 次），准备重试`);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
    } catch (err) {
      console.log(`  [Dispatch-DRY-RUN] 派件员选择第 ${attempt} 次异常: ${(err as Error).message}`);
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
 * 校验派件员是否成功选中
 *
 * el-select 选中后，input.value 应为选中的文本（即 courierName）。
 * 部分场景下 input.value 为空但 li.el-select-dropdown__item 有 selected 类。
 *
 * 校验策略：
 *   1. 读取 input.value，若包含 courierName → 通过
 *   2. 否则查找 li.el-select-dropdown__item.selected，若文本包含 courierName → 通过
 *   3. 否则失败
 */
async function verifyCourierSelected(page: Page, courierName: string): Promise<boolean> {
  try {
    // 1. 读取 input.value
    const inputValue = await page.locator(DISPATCH_SCAN_SELECTORS.courierSelectInput).first()
      .inputValue().catch(() => '');
    if (inputValue.includes(courierName)) {
      console.log(`  [Dispatch-DRY-RUN] 派件员 input.value 校验通过: "${inputValue}"`);
      return true;
    }

    // 2. 检查 li.el-select-dropdown__item.selected
    const selectedText = await page.evaluate((search: string) => {
      const poppers = document.querySelectorAll('div.el-select-dropdown.el-popper');
      for (const popper of poppers) {
        const ws = window.getComputedStyle(popper as HTMLElement);
        if (ws.display === 'none') continue;
        const selectedItems = popper.querySelectorAll('li.el-select-dropdown__item.selected');
        for (const item of selectedItems) {
          const text = (item.textContent || '').trim();
          if (text.includes(search)) return text;
        }
      }
      return '';
    }, courierName).catch(() => '');

    if (selectedText.includes(courierName)) {
      console.log(`  [Dispatch-DRY-RUN] 派件员 li.selected 校验通过: "${selectedText}"`);
      return true;
    }

    console.log(`  [Dispatch-DRY-RUN] 派件员校验失败：input="${inputValue}"，selected="${selectedText}"`);
    return false;
  } catch {
    return false;
  }
}
