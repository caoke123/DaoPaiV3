/**
 * IntegratedBrowserDryRun — 到派一体扫描浏览器 DRY-RUN 页面操作
 *
 * Phase 5-F: 在笨鸟系统中执行到派一体扫描页面级 DRY-RUN。
 *
 * 选择器来源：
 *   backend/operations/selectors/integratedScan.selectors.ts
 * 交互顺序来源：
 *   backend/operations/IntegratedScan.ts:157-223 processOneBatch
 *
 * 硬性边界：
 *   - 禁止点击"上传"按钮（最终提交）
 *   - 禁止点击"添加"按钮（spec 白名单只允许查询/搜索/检索）
 *   - 允许勾选"到派一体"复选框（选择必要业务字段）
 *   - 允许选"上一站"（选择必要业务字段）
 *   - 不产生真实业务，不处理真实生产单号
 */

import type { Page, ElementHandle } from 'playwright-core';
import { detectIntegratedPage, type IntegratedPageDetectResult } from './IntegratedPageDetector';
import { detectBnsyDashboardP0 } from './BnsyDashboardDetector';
import { stableFillInput, verifyInputValue, stableClick } from './StablePageActions';
import {
  INTEGRATED_SCAN_SELECTORS,
  INTEGRATED_PAGE_ROUTE,
  DEFAULT_PREV_STATION,
} from './integratedSelectors';

export interface IntegratedBrowserDryRunInput {
  siteId: string;
  siteName: string;
  waybills: string[];
  options?: {
    prevStation?: string;
    /** 派件员姓名（用于回填校验） */
    courierName?: string;
    /** 派件员员工编号（用于弹窗表格精确匹配） */
    courierEmployeeId?: string;
  };
}

export interface IntegratedBrowserDryRunResult {
  success: boolean;
  pageUrl: string;
  title: string;
  inputCount: number;
  prevStationSelected: boolean;
  integratedCheckboxChecked: boolean;
  courierSelected: boolean;
  clickedButton: 'none' | 'search';
  finalSubmitClicked: false;
  detectBefore: IntegratedPageDetectResult | null;
  detectAfter: IntegratedPageDetectResult | null;
  message: string;
  warnings: string[];
  validationLogs: string[];
}

// 到派一体页面 URL（来源：PageStateManager.ts:21 INTEGRATED_PAGE_ROUTE）
const INTEGRATED_PAGE_URL = `https://bnsy.benniaosuyun.com${INTEGRATED_PAGE_ROUTE}`;

// 禁止点击的按钮关键词
const FORBIDDEN_BUTTON_KEYWORDS = [
  '上传', '提交', '确认', '批量', '派件', '签收', '保存', '完成', '执行', '到派',
];

function assertNotFinalSubmit(text: string): void {
  const normalized = text.replace(/\s+/g, '');
  for (const kw of FORBIDDEN_BUTTON_KEYWORDS) {
    if (normalized.includes(kw)) {
      throw new Error(`安全保护：禁止点击疑似最终提交按钮（文本: "${text}"，匹配关键词: "${kw}"）`);
    }
  }
}

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
      console.log(`  [Integrated-DRY-RUN] 弹窗清理: ${result.actions.join('; ')}`);
      await page.waitForTimeout(1000);
    }
  } catch {
    // 忽略清理失败
  }
}

/**
 * 执行到派一体扫描浏览器 DRY-RUN
 *
 * 选择器和交互流程严格遵循旧代码：
 *   - 上一站：INTEGRATED_SCAN_SELECTORS.prevStationInput + prevStationOption（el-select 下拉）
 *   - 到派一体复选框：INTEGRATED_SCAN_SELECTORS.integratedCheckbox
 *   - 运单输入框：INTEGRATED_SCAN_SELECTORS.waybillInput
 *   - 添加按钮：INTEGRATED_SCAN_SELECTORS.addButton（仅检测，不点击）
 *   - 上传按钮：INTEGRATED_SCAN_SELECTORS.uploadButton（仅检测，绝不点击）
 */
export async function runIntegratedBrowserDryRun(
  page: Page,
  input: IntegratedBrowserDryRunInput,
): Promise<IntegratedBrowserDryRunResult> {
  const warnings: string[] = [];
  const { waybills, options } = input;
  const prevStation = options?.prevStation || DEFAULT_PREV_STATION;
  const courierName = options?.courierName;
  const courierEmployeeId = options?.courierEmployeeId;

  const result: IntegratedBrowserDryRunResult = {
    success: false,
    pageUrl: '',
    title: '',
    inputCount: 0,
    prevStationSelected: false,
    integratedCheckboxChecked: false,
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
  console.log('  [Integrated-DRY-RUN] 检测 Dashboard P0...');
  const p0 = await detectBnsyDashboardP0(page);
  if (p0.status !== 'READY') {
    result.message = `Dashboard P0 不是 READY，拒绝执行 DRY-RUN（状态: ${p0.status}）`;
    warnings.push(`P0 状态: ${p0.status} - ${p0.message}`);
    return result;
  }
  console.log('  [Integrated-DRY-RUN] Dashboard P0 = READY');

  // 2. 进入到派一体页面
  console.log(`  [Integrated-DRY-RUN] 导航到到派一体页面: ${INTEGRATED_PAGE_URL}`);
  console.log(`  [Integrated-DRY-RUN] 到派一体页面 URL 来源: PageStateManager.ts:21 INTEGRATED_PAGE_ROUTE`);
  try {
    const dashboardUrl = 'https://bnsy.benniaosuyun.com/dashboard';
    if (!page.url().includes('/dashboard')) {
      await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(3000);
    }

    await page.goto(INTEGRATED_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(3000);

    let currentUrl = page.url();
    if (currentUrl.includes('/dashboard')) {
      console.log(`  [Integrated-DRY-RUN] 直接导航被重定向，尝试 Vue Router...`);
      await page.evaluate((url) => {
        const app = document.querySelector('#app') as any;
        if (app && app.__vue__ && app.__vue__.$router) {
          app.__vue__.$router.push(url.replace('https://bnsy.benniaosuyun.com', ''));
        } else {
          window.location.href = url;
        }
      }, INTEGRATED_PAGE_URL);
      await page.waitForTimeout(3000);
    }

    currentUrl = page.url();
    console.log(`  [Integrated-DRY-RUN] 当前 URL: ${currentUrl}`);
  } catch (err) {
    result.message = `到派一体页面打开失败: ${(err as Error).message}`;
    return result;
  }

  result.pageUrl = page.url();
  try {
    result.title = await page.title();
  } catch {
    result.title = '(无法获取标题)';
  }
  console.log(`  [Integrated-DRY-RUN] 页面已打开: ${result.pageUrl}`);

  await cleanPagePopups(page);

  // 3. 检测到派一体页面元素（输入前）
  console.log('  [Integrated-DRY-RUN] 检测到派一体页面元素（输入前）...');
  const detectBefore = await detectIntegratedPage(page);
  result.detectBefore = detectBefore;

  console.log(`  [Integrated-DRY-RUN] 是否到派一体页面: ${detectBefore.isIntegratedPage}`);
  console.log(`  [Integrated-DRY-RUN] 上一站输入框: ${detectBefore.hasPrevStationInput ? '已检测到' : '未检测到'}`);
  console.log(`  [Integrated-DRY-RUN] 到派一体复选框: ${detectBefore.hasIntegratedCheckbox ? '已检测到' : '未检测到'}`);
  console.log(`  [Integrated-DRY-RUN] 运单输入框: ${detectBefore.hasWaybillInput ? '已检测到' : '未检测到'}`);
  console.log(`  [Integrated-DRY-RUN] 添加按钮: ${detectBefore.hasAddButton ? '已检测到（不点击）' : '未检测到'}`);
  console.log(`  [Integrated-DRY-RUN] 上传按钮: ${detectBefore.hasUploadButton ? '已检测到（不点击）' : '未检测到'}`);

  // 4. 选"上一站"= 天津分拨中心
  //    选择器来源：integratedScan.selectors.ts:27 prevStationInput, :30 prevStationOption
  //    交互顺序来源：IntegratedScan.ts:241-272 selectPrevStation
  let prevStationSuccess = false;
  if (detectBefore.hasPrevStationInput && prevStation) {
    console.log(`  [Integrated-DRY-RUN] 上一站填写开始：${prevStation}`);
    console.log(`  [Integrated-DRY-RUN] 上一站 input 选择器来源: integratedScan.selectors.ts:27 prevStationInput`);
    console.log(`  [Integrated-DRY-RUN] 上一站 option 选择器来源: integratedScan.selectors.ts:30 prevStationOption`);
    console.log(`  [Integrated-DRY-RUN] 上一站交互方式: 点击 input → 等 800ms → 选择下拉候选 → 校验 value`);
    result.validationLogs.push(`上一站填写开始：${prevStation}`);
    try {
      prevStationSuccess = await stableFillPrevStation(page, prevStation);
      if (prevStationSuccess) {
        result.prevStationSelected = true;
        console.log(`  [Integrated-DRY-RUN] 上一站填写校验通过：${prevStation}`);
        result.validationLogs.push(`上一站填写校验通过：${prevStation}`);
      } else {
        console.log(`  [Integrated-DRY-RUN] 上一站填写失败：未确认选中"${prevStation}"`);
      }
    } catch (err) {
      console.log(`  [Integrated-DRY-RUN] 上一站填写异常: ${(err as Error).message}`);
    }

    if (!prevStationSuccess) {
      warnings.push(`上一站填写失败：未确认选中"${prevStation}"`);
    }
  }

  // 5. 勾选"到派一体"复选框
  //    选择器来源：integratedScan.selectors.ts:33 integratedCheckbox
  //    交互顺序来源：IntegratedScan.ts:287-319 checkIntegratedCheckbox
  let integratedCheckboxSuccess = false;
  if (detectBefore.hasIntegratedCheckbox) {
    console.log(`  [Integrated-DRY-RUN] 勾选"到派一体"复选框...`);
    console.log(`  [Integrated-DRY-RUN] 到派一体复选框选择器来源: integratedScan.selectors.ts:33 integratedCheckbox`);
    result.validationLogs.push(`勾选到派一体复选框开始`);
    try {
      // 检查是否已勾选（旧代码 IntegratedScan.ts:296-302）
      const checkedLoc = page.locator('.el-checkbox:has-text("到派一体").is-checked');
      const isChecked = await checkedLoc.count();

      if (isChecked > 0) {
        integratedCheckboxSuccess = true;
        console.log(`  [Integrated-DRY-RUN] "到派一体"已勾选，跳过`);
        result.validationLogs.push(`到派一体复选框已勾选`);
      } else {
        // 点击 checkbox（旧代码 IntegratedScan.ts:312）
        const checkboxLoc = page.locator(INTEGRATED_SCAN_SELECTORS.integratedCheckbox);
        const cbCount = await checkboxLoc.count();

        if (cbCount === 0) {
          warnings.push('未找到"到派一体"复选框');
          console.log(`  [Integrated-DRY-RUN] 未找到"到派一体"复选框`);
        } else {
          await stableClick(checkboxLoc.first(), { timeoutMs: 5000 });
          await page.waitForTimeout(800); // 等待派件员下拉框出现（旧代码 IntegratedScan.ts:313）

          // 验证勾选成功
          const checkedAfter = await page.locator('.el-checkbox:has-text("到派一体").is-checked').count();
          if (checkedAfter > 0) {
            integratedCheckboxSuccess = true;
            result.integratedCheckboxChecked = true;
            console.log(`  [Integrated-DRY-RUN] "到派一体"已勾选`);
            result.validationLogs.push(`到派一体复选框已勾选`);
          } else {
            warnings.push('"到派一体"复选框勾选后验证失败');
            console.log(`  [Integrated-DRY-RUN] "到派一体"复选框勾选后验证失败`);
          }
        }
      }
    } catch (err) {
      warnings.push(`勾选"到派一体"失败: ${(err as Error).message}`);
      console.log(`  [Integrated-DRY-RUN] 勾选"到派一体"异常: ${(err as Error).message}`);
    }
  }

  // 6. 选派件员 —— 触发"选择派件员"弹窗，按员工编号精确匹配，点击"使用"按钮
  //    选择器来源：integratedSelectors.ts courierSelectInput / courierDialogWrapper /
  //                courierDialogTableRow / courierDialogEmployeeIdCell / courierUseButton
  //    交互顺序来源：IntegratedScan.ts:341-464 selectCourier
  //    ⚠️ 必须用 Playwright 真实 .click() 点击（不能用 page.evaluate），否则 Vue 监听器不响应
  //    ⚠️ "使用"按钮不是最终提交，是必要业务字段选择，允许点击
  //    ⚠️ 派件员 input 在勾选"到派一体"复选框后才动态出现，不能用 detectBefore 检测结果
  //       （detectBefore 是勾选前检测，hasCourierSelectInput 必然为 false）
  //       selectCourier 内部会用 locator.count() 重新检测，找不到时返回 false
  let courierSelectSuccess = false;
  if (integratedCheckboxSuccess && courierName && courierEmployeeId) {
    console.log(`  [Integrated-DRY-RUN] 选派件员开始：${courierName} (employeeId=${courierEmployeeId})`);
    console.log(`  [Integrated-DRY-RUN] 派件员 input 选择器来源: integratedSelectors.ts courierSelectInput`);
    console.log(`  [Integrated-DRY-RUN] 派件员弹窗选择器来源: integratedSelectors.ts courierDialogWrapper`);
    console.log(`  [Integrated-DRY-RUN] 派件员表格行选择器来源: integratedSelectors.ts courierDialogTableRow`);
    console.log(`  [Integrated-DRY-RUN] 员工编号列选择器来源: integratedSelectors.ts courierDialogEmployeeIdCell`);
    console.log(`  [Integrated-DRY-RUN] 使用按钮选择器来源: integratedSelectors.ts courierUseButton`);
    result.validationLogs.push(`选派件员开始：${courierName} (employeeId=${courierEmployeeId})`);
    try {
      courierSelectSuccess = await selectCourier(page, courierName, courierEmployeeId);
      if (courierSelectSuccess) {
        result.courierSelected = true;
        console.log(`  [Integrated-DRY-RUN] 派件员选择校验通过：${courierName}`);
        result.validationLogs.push(`派件员选择校验通过：${courierName}`);
      } else {
        console.log(`  [Integrated-DRY-RUN] 派件员选择校验失败：未确认选中"${courierName}"`);
      }
    } catch (err) {
      console.log(`  [Integrated-DRY-RUN] 派件员选择异常: ${(err as Error).message}`);
    }

    if (!courierSelectSuccess) {
      warnings.push(`派件员选择失败：未确认选中"${courierName}"`);
    }
  } else if (integratedCheckboxSuccess && (!courierName || !courierEmployeeId)) {
    console.log(`  [Integrated-DRY-RUN] 未提供 courierName/courierEmployeeId，跳过派件员选择`);
    warnings.push('未提供派件员信息，跳过派件员选择');
  }

  // 7. 稳定输入测试运单
  //    选择器来源：integratedScan.selectors.ts:77 waybillInput
  //    旧代码使用位置：IntegratedScan.ts:519, 522
  let waybillInputSuccess = false;
  if (detectBefore.hasWaybillInput && waybills.length > 0) {
    console.log(`  [Integrated-DRY-RUN] 稳定输入测试运单 (${waybills.length} 条)...`);
    console.log(`  [Integrated-DRY-RUN] 运单输入框选择器来源: integratedScan.selectors.ts:77 waybillInput`);
    try {
      const waybillInput = page.locator(INTEGRATED_SCAN_SELECTORS.waybillInput).first();
      if (await waybillInput.isVisible({ timeout: 5000 })) {
        const testWaybill = waybills[0];
        await stableFillInput(waybillInput, testWaybill, { maxRetries: 3 });
        const verified = await verifyInputValue(waybillInput, testWaybill, { timeoutMs: 2000 });
        if (verified) {
          result.inputCount = 1;
          waybillInputSuccess = true;
          console.log(`  [Integrated-DRY-RUN] 运单输入校验通过：${testWaybill}`);
          result.validationLogs.push(`运单输入校验通过：${testWaybill}`);
        } else {
          warnings.push('运单输入校验失败');
          console.log(`  [Integrated-DRY-RUN] 运单输入校验失败`);
        }
      } else {
        warnings.push('运单输入框不可见');
      }
    } catch (err) {
      warnings.push(`运单输入失败: ${(err as Error).message}`);
      console.log(`  [Integrated-DRY-RUN] 运单输入异常: ${(err as Error).message}`);
    }
  }

  // 8. 输入前置校验：上一站 + 到派一体复选框 + 派件员 + 运单输入必须全部成功
  console.log('  [Integrated-DRY-RUN] 输入前置校验开始...');
  const preInputChecks = {
    prevStation: prevStationSuccess,
    integratedCheckbox: integratedCheckboxSuccess,
    courier: courierSelectSuccess,
    waybill: waybillInputSuccess,
  };
  console.log(`  [Integrated-DRY-RUN] 校验结果：上一站=${preInputChecks.prevStation}，到派一体=${preInputChecks.integratedCheckbox}，派件员=${preInputChecks.courier}，运单=${preInputChecks.waybill}`);

  if (!preInputChecks.prevStation || !preInputChecks.integratedCheckbox || !preInputChecks.courier || !preInputChecks.waybill) {
    const failedParts: string[] = [];
    if (!preInputChecks.prevStation) failedParts.push('上一站填写');
    if (!preInputChecks.integratedCheckbox) failedParts.push('到派一体勾选');
    if (!preInputChecks.courier) failedParts.push('派件员选择');
    if (!preInputChecks.waybill) failedParts.push('运单输入');
    result.message = `输入前置校验失败：${failedParts.join('、')}未通过，已停止执行`;
    result.success = false;
    result.validationLogs.push(`输入校验失败，已停止执行，未点击上传`);
    console.log(`  [Integrated-DRY-RUN] ${result.message}`);
    return result;
  }
  console.log('  [Integrated-DRY-RUN] 输入前置校验通过');
  result.validationLogs.push('输入前置校验通过');

  // 9. 安全检测添加按钮和上传按钮（仅检测，不点击）
  console.log(`  [Integrated-DRY-RUN] 添加按钮选择器来源: integratedScan.selectors.ts:80 addButton（仅检测，不点击）`);
  console.log(`  [Integrated-DRY-RUN] 上传按钮选择器来源: integratedScan.selectors.ts:92 uploadButton（仅检测，不点击）`);
  result.validationLogs.push('已检测添加按钮（未点击）');
  result.validationLogs.push('已检测上传按钮（未点击）');
  result.validationLogs.push('已阻止最终提交');

  // 10. 再次检测页面元素（输入后）
  console.log('  [Integrated-DRY-RUN] 检测到派一体页面元素（输入后）...');
  const detectAfter = await detectIntegratedPage(page);
  result.detectAfter = detectAfter;

  // 11. 明确 finalSubmitClicked = false
  result.finalSubmitClicked = false;
  result.clickedButton = 'none';

  // 12. 结果
  result.success = true;
  result.message = '到派一体 DRY-RUN 完成：已选上一站+勾选到派一体+选派件员+输入运单，未点击添加按钮，未点击上传按钮';

  console.log(`  [Integrated-DRY-RUN] ${result.message}`);
  return result;
}

// ══════════════════════════════════════════════════════════
// Phase 5-F-0 DOM 审计后修复：基于 label 文本定位"上一站" input
//
// 审计结论（commit ad89249）：
//   - 旧 selector `.arrivalscan_left .el-input--suffix input` + `.first()`
//     命中的是 Row 2「班次」，不是 Row 7「上一站」，导致任务卡住。
//   - 修复策略：弃用 `.first()`，改用 label 文本"上一站"向上查找祖先容器定位 input。
//
// 交互顺序（保留旧代码 IntegratedScan.ts:241-272 的可靠部分）：
//   1. findPrevStationInputByLabel：遍历 .arrivalscan_left input，向上找祖先
//      textContent 同时满足 includes("上一站") && !includes("班次")
//   2. assertNotShiftField：再次校验候选 input 不在班次行（双保险）
//   3. 点击 input → 等 800ms → force click 候选项 → DOM click 兜底 → fill+Enter 兜底
//   4. 三重校验：input.value / el-tag / li.selected
// ══════════════════════════════════════════════════════════

/**
 * Phase 5-F-0: 基于 label 文本定位"上一站" input
 *
 * 审计验证：到派一体左侧表单 Row 7 是 label="上一站" 的行，Row 2 是 label="班次" 的行。
 * 旧 .first() 命中 Row 2 班次，本函数改用 label 文本向上查找行容器定位 Row 7 上一站。
 *
 * 策略（关键：只检查行级容器文本，不检查 .arrivalscan_left 级别）：
 *   1. 遍历 .arrivalscan_left 内所有 input
 *   2. 对每个 input 向上查找"行容器"（.arrivalscan_left > div 的直接子 div）
 *   3. 检查行容器 textContent：
 *      - 必须包含 "上一站"
 *      - 必须不包含 "班次"
 *   4. 命中即返回该 input 的 ElementHandle
 *
 * 注意：不能向上查找过深，否则会到达 .arrivalscan_left 级别，
 *       那里包含所有字段文本（同时含"上一站"和"班次"），导致误判。
 *
 * @returns ElementHandle 或 null（未找到时回退到 nth-child(7) selector）
 */
async function findPrevStationInputByLabel(
  page: Page,
): Promise<ElementHandle<HTMLInputElement> | null> {
  const handle = await page.evaluateHandle(() => {
    const leftPanel = document.querySelector('.arrivalscan_left');
    if (!leftPanel) return null;

    // 到派一体左侧表单结构：.arrivalscan_left > div > div(每个表单行)
    // rowContainer = .arrivalscan_left > div（包含所有行的容器）
    const rowContainer = leftPanel.querySelector(':scope > div');
    if (!rowContainer) return null;

    const inputs = leftPanel.querySelectorAll('input');
    for (const input of inputs) {
      const inputEl = input as HTMLInputElement;

      // 向上查找所属行：rowContainer 的直接子元素
      let node: Node | null = inputEl.parentElement;
      let depth = 0;
      while (node && depth < 8 && node !== rowContainer && node !== leftPanel) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          // 行容器的特征：parentElement === rowContainer
          if (el.parentElement === rowContainer) {
            const rowText = el.textContent || '';
            // 行级文本必须包含"上一站"，且不包含"班次"
            if (rowText.includes('上一站') && !rowText.includes('班次')) {
              return inputEl;
            }
            break; // 找到行容器但不符合，跳过这个 input
          }
        }
        node = node.parentNode;
        depth++;
      }
    }
    return null;
  });

  const element = handle.asElement() as ElementHandle<HTMLInputElement> | null;
  return element;
}

/**
 * Phase 5-F-0: 班次字段保护
 *
 * 校验候选 input 的所属行不是班次字段。
 * 只检查行级容器文本（不检查 .arrivalscan_left 级别，避免误中所有字段）。
 *
 * 这是双保险：findPrevStationInputByLabel 已经排除班次，本函数在点击前再校验一次。
 */
async function assertNotShiftField(
  inputHandle: ElementHandle,
): Promise<void> {
  const isShift = await inputHandle.evaluate((el) => {
    const leftPanel = document.querySelector('.arrivalscan_left');
    if (!leftPanel) return false;
    const rowContainer = leftPanel.querySelector(':scope > div');
    if (!rowContainer) return false;

    // 向上查找所属行
    let node: Node | null = el.parentElement;
    let depth = 0;
    while (node && depth < 8 && node !== rowContainer && node !== leftPanel) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el2 = node as HTMLElement;
        if (el2.parentElement === rowContainer) {
          // 找到行容器，只检查这一行的文本
          const rowText = el2.textContent || '';
          return rowText.includes('班次');
        }
      }
      node = node.parentNode;
      depth++;
    }
    return false;
  });

  if (isShift) {
    throw new Error('错误：当前元素是班次字段，禁止作为上一站使用');
  }
}

async function stableFillPrevStation(page: Page, prevStation: string): Promise<boolean> {
  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`  [Integrated-DRY-RUN] 上一站填写第 ${attempt} 次尝试...`);

    try {
      // Step 1: 基于 label 文本定位"上一站" input（Phase 5-F-0 修复）
      // 审计结论：旧 .first() 命中 Row 2「班次」，本修复改用 label 文本"上一站"向上查找
      let prevInputHandle = await findPrevStationInputByLabel(page);

      if (!prevInputHandle) {
        // 兜底：使用审计确认的 nth-child(7) selector
        console.log(`  [Integrated-DRY-RUN] label 定位未命中，回退到 nth-child(7) selector`);
        const fallbackLoc = page.locator(INTEGRATED_SCAN_SELECTORS.prevStationInputByRow);
        if (await fallbackLoc.count() === 0) {
          console.log(`  [Integrated-DRY-RUN] 兜底 selector 也未命中，放弃本次尝试`);
          continue;
        }
        const fallbackHandle = await fallbackLoc.first().elementHandle();
        if (!fallbackHandle) continue;
        prevInputHandle = fallbackHandle as ElementHandle<HTMLInputElement>;
      }

      // Step 2: 班次字段保护（双保险）
      await assertNotShiftField(prevInputHandle);
      console.log(`  [Integrated-DRY-RUN] 已通过班次保护校验，确认是上一站 input`);

      // Step 3: 点击 input 打开下拉（旧代码 IntegratedScan.ts:241）
      await prevInputHandle.click({ timeout: 10_000 });
      console.log(`  [Integrated-DRY-RUN] 已点击上一站 input`);

      // Step 4: 等待下拉浮层出现（旧代码 IntegratedScan.ts:242）
      await page.waitForTimeout(800);

      // Step 5: 优先用 Playwright force click（跳过可见性检查 + 触发真实事件让 Vue 响应）
      // 到派一体浮层在 DOM 中但 Playwright 认为不可见，必须 force:true
      // 选择器来源：integratedSelectors.ts prevStationOption
      const prevOptionLoc = page.locator(INTEGRATED_SCAN_SELECTORS.prevStationOption);
      const prevCount = await prevOptionLoc.count();
      console.log(`  [Integrated-DRY-RUN] 候选项数量: ${prevCount}`);

      let clicked = false;
      if (prevCount > 0) {
        try {
          await prevOptionLoc.first().click({ force: true, timeout: 5000 });
          clicked = true;
          console.log(`  [Integrated-DRY-RUN] 已点击候选项（Playwright force click）`);
        } catch (err) {
          console.log(`  [Integrated-DRY-RUN] force click 失败: ${(err as Error).message}，降级 DOM click`);
        }
      }

      // Step 6: force click 失败时，用 page.evaluate DOM click（旧代码 IntegratedScan.ts:245-254 原样）
      if (!clicked) {
        const domClicked = await page.evaluate((stationName) => {
          const items = document.querySelectorAll('li.el-select-dropdown__item');
          for (const item of items) {
            if (item.textContent && item.textContent.includes(stationName)) {
              (item as HTMLElement).click();
              return true;
            }
          }
          return false;
        }, prevStation);

        if (domClicked) {
          clicked = true;
          console.log(`  [Integrated-DRY-RUN] 已点击候选项（DOM click 兜底）`);
        }
      }

      // Step 7: 仍未点击到候选项 → fill + Enter 兜底（旧代码 IntegratedScan.ts:261-262）
      if (!clicked) {
        console.log(`  [Integrated-DRY-RUN] 未找到候选项，使用兜底策略：fill + Enter`);
        // 重新获取 handle（前一个可能已 detached）
        const fillHandle = await findPrevStationInputByLabel(page) ?? prevInputHandle;
        await fillHandle.fill(prevStation, { timeout: 5000 });
        await page.keyboard.press('Enter');
      }

      await page.waitForTimeout(500);

      // Step 8: 校验（与 Arrival 一致 + 增加 li.selected 检查）
      const verified = await verifyPrevStationSelected(page, prevStation);
      if (verified) {
        console.log(`  [Integrated-DRY-RUN] 上一站校验通过（第 ${attempt} 次）`);
        return true;
      }

      console.log(`  [Integrated-DRY-RUN] 上一站校验失败（第 ${attempt} 次），准备重试`);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(300);
    } catch (err) {
      console.log(`  [Integrated-DRY-RUN] 上一站填写第 ${attempt} 次异常: ${(err as Error).message}`);
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
 * Element el-select 选中后，可能有三种表现：
 *   1. input.value 直接为选中文本（普通模式）
 *   2. input.value 为空，但显示 el-tag（多选/远程模式）
 *   3. li.el-select-dropdown__item 有 selected 类（Element UI 内部状态）
 *
 * Phase 5-F-0 修复：input.value 读取改用 findPrevStationInputByLabel，
 *                   避免旧 .first() 命中班次 input。
 *
 * 校验策略（增强版，处理到派一体页面 el-select 特殊行为）：
 *   - 先读 input.value（基于 label 定位），若包含 prevStation → 通过
 *   - 否则查找 el-select__tags 或 .el-tag，若包含 prevStation → 通过
 *   - 否则查找 li.el-select-dropdown__item.selected，若文本包含 prevStation → 通过
 *   - 否则失败
 */
async function verifyPrevStationSelected(page: Page, prevStation: string): Promise<boolean> {
  try {
    // 1. 读取 input.value（Phase 5-F-0：基于 label 定位，不再用 .first()）
    let inputValue = '';
    const prevInputHandle = await findPrevStationInputByLabel(page);
    if (prevInputHandle) {
      inputValue = await prevInputHandle.inputValue().catch(() => '');
    } else {
      // 兜底：nth-child(7) selector
      inputValue = await page.locator(INTEGRATED_SCAN_SELECTORS.prevStationInputByRow)
        .first().inputValue().catch(() => '');
    }

    if (inputValue.includes(prevStation)) {
      console.log(`  [Integrated-DRY-RUN] 上一站 input.value 校验通过: "${inputValue}"`);
      return true;
    }

    // 2. 检查 el-tag 文本（Element 多选/复杂模式）
    const tagText = await page.evaluate((search: string) => {
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
      console.log(`  [Integrated-DRY-RUN] 上一站 el-tag 校验通过: "${tagText}"`);
      return true;
    }

    // 3. 检查 li.el-select-dropdown__item.selected（Element UI 内部选中状态）
    const selectedText = await page.evaluate((search: string) => {
      const selectedItems = document.querySelectorAll('li.el-select-dropdown__item.selected');
      for (const item of selectedItems) {
        const text = (item.textContent || '').trim();
        if (text.includes(search)) return text;
      }
      return '';
    }, prevStation).catch(() => '');

    if (selectedText.includes(prevStation)) {
      console.log(`  [Integrated-DRY-RUN] 上一站 li.selected 校验通过: "${selectedText}"`);
      return true;
    }

    // 4. 校验失败
    console.log(`  [Integrated-DRY-RUN] 上一站校验失败：input="${inputValue}"，tag="${tagText}"，selected="${selectedText}"`);
    return false;
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════════════
// 选派件员 —— 触发"选择派件员"弹窗，按员工编号精确匹配，点击"使用"按钮
//
// 严格遵循旧代码 IntegratedScan.ts:341-464 selectCourier 原样逻辑：
//   1. Playwright 真实 .click() 点击派件员 input（触发 Vue 监听器弹出弹窗）
//   2. 等待 div.el-dialog__wrapper 弹窗出现（textContent 包含"选择派件员"）
//   3. 遍历 el-table 表格行，按 el-table_2_column_16（员工编号列）精确匹配 employeeId
//      （字符串严格相等，不用 includes 模糊匹配）
//   4. 点击匹配行的"使用"按钮（位于 .el-table__fixed-right 固定列内）
//      ⚠️ "使用"按钮不是最终提交，是必要业务字段选择
//   5. 验证：弹窗关闭 + 派件员 input 回填的姓名与传入 courierName 一致
//
// ⚠️ 关键：必须用 Playwright 真实 .click()（page.click / locator.click），
//    不能用 page.evaluate(el => el.click()) —— 后者不触发 Vue 监听器，
//    弹窗不会弹出，"使用"按钮点击也不会生效。
//
// 选择器来源：
//   - courierSelectInput: integratedSelectors.ts（来源 integratedScan.selectors.ts:44）
//   - courierDialogWrapper: integratedSelectors.ts（来源 integratedScan.selectors.ts:56）
//   - courierDialogTableRow: integratedSelectors.ts（来源 integratedScan.selectors.ts:59）
//   - courierDialogEmployeeIdCell: integratedSelectors.ts（来源 integratedScan.selectors.ts:65）
//   - courierUseButton: integratedSelectors.ts（来源 integratedScan.selectors.ts:74）
// ══════════════════════════════════════════════════════════

async function selectCourier(
  page: Page,
  courierName: string,
  courierEmployeeId: string,
): Promise<boolean> {
  // Step 1: Playwright 真实 .click() 点击派件员 input 触发弹窗
  console.log(`  [Integrated-DRY-RUN] 派件员 Step1: 点击派件员 input 触发弹窗`);
  const inputLoc = page.locator(INTEGRATED_SCAN_SELECTORS.courierSelectInput);
  const inputCount = await inputLoc.count();
  if (inputCount === 0) {
    console.log(`  [Integrated-DRY-RUN] 未找到派件员 input（选择器: ${INTEGRATED_SCAN_SELECTORS.courierSelectInput}）`);
    return false;
  }

  try {
    await inputLoc.first().click({ timeout: 10_000 });
  } catch (err) {
    console.log(`  [Integrated-DRY-RUN] 点击派件员 input 失败: ${(err as Error).message}`);
    return false;
  }

  // Step 2: 等待"选择派件员"弹窗出现
  console.log(`  [Integrated-DRY-RUN] 派件员 Step2: 等待"选择派件员"弹窗出现`);
  const dialogLoc = page.locator(INTEGRATED_SCAN_SELECTORS.courierDialogWrapper);
  try {
    await dialogLoc.waitFor({ state: 'visible', timeout: 10_000 });
  } catch (err) {
    console.log(`  [Integrated-DRY-RUN] "选择派件员"弹窗未出现: ${(err as Error).message}`);
    return false;
  }
  console.log(`  [Integrated-DRY-RUN] "选择派件员"弹窗已出现`);

  // Step 3: 遍历表格行，按员工编号精确匹配 employeeId
  //    旧代码使用固定列选择器 td.el-table_2_column_16，但实际页面 el-table id 可能不同
  //    改为更通用的方式：用 page.evaluate 遍历每行所有 td，找文本严格等于 employeeId 的单元格
  console.log(`  [Integrated-DRY-RUN] 派件员 Step3: 遍历表格行按员工编号精确匹配 (employeeId=${courierEmployeeId})`);

  const matchResult = await page.evaluate((args: { rowSelector: string; targetId: string }) => {
    const rows = document.querySelectorAll(args.rowSelector);
    const idDump: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i].querySelectorAll('td');
      for (const cell of cells) {
        const text = (cell.textContent || '').trim();
        if (text && text.length > 0) {
          idDump.push(`[行${i + 1}列${cell.className || '?'}]=${text}`);
        }
        // 严格相等匹配 employeeId
        if (text === args.targetId) {
          return { matchedRowIdx: i, idDump, matchedText: text };
        }
      }
    }
    return { matchedRowIdx: -1, idDump, matchedText: '' };
  }, {
    rowSelector: INTEGRATED_SCAN_SELECTORS.courierDialogTableRow,
    targetId: courierEmployeeId,
  }).catch(() => ({ matchedRowIdx: -1, idDump: [], matchedText: '' }));

  const rowCount = matchResult.idDump.length;
  console.log(`  [Integrated-DRY-RUN] 弹窗表格扫描单元格数: ${rowCount}`);

  if (matchResult.matchedRowIdx === -1) {
    console.log(`  [Integrated-DRY-RUN] 未找到员工编号=${courierEmployeeId} 的行。表格扫描结果: ${JSON.stringify(matchResult.idDump.slice(0, 20))}`);
    // 关闭弹窗，避免阻塞后续操作
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
    return false;
  }

  console.log(`  [Integrated-DRY-RUN] 匹配命中: 第${matchResult.matchedRowIdx + 1}行, 员工编号=${matchResult.matchedText}`);
  const matchedRowIdx = matchResult.matchedRowIdx;

  // Step 4: 点击匹配行的"使用"按钮（位于 .el-table__fixed-right 固定列内）
  // Element UI 固定列机制：操作列在主表中 is-hidden，在 .el-table__fixed-right 中可见
  // 匹配行索引在主表和固定列表中是一致的（同一行数据）
  console.log(`  [Integrated-DRY-RUN] 派件员 Step4: 点击第${matchedRowIdx + 1}行的"使用"按钮`);
  const useButtonLoc = page.locator(INTEGRATED_SCAN_SELECTORS.courierUseButton).nth(matchedRowIdx);

  try {
    await useButtonLoc.click({ timeout: 5_000 });
  } catch (err) {
    console.log(`  [Integrated-DRY-RUN] 点击"使用"按钮失败: ${(err as Error).message}`);
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
    return false;
  }

  // Step 5: 验证 —— 弹窗关闭 + 派件员 input 回填的姓名与传入 courierName 一致
  console.log(`  [Integrated-DRY-RUN] 派件员 Step5: 验证弹窗关闭 + 派件员 input 回填`);

  // 等待弹窗关闭（Element UI 关闭动画约 300-500ms，给 5s 兜底）
  let dialogClosed = true;
  try {
    await dialogLoc.waitFor({ state: 'hidden', timeout: 5000 });
  } catch {
    dialogClosed = false;
  }

  if (!dialogClosed) {
    // 弹窗未关闭 —— 可能是"使用"按钮未生效，但也可能是动画未完成
    // 用派件员 input 回填值做兜底判断：如果已回填正确姓名，说明选择已生效
    const fallbackValue = await page.locator(INTEGRATED_SCAN_SELECTORS.courierSelectInput).first()
      .inputValue().catch(() => '');
    if (fallbackValue === courierName) {
      console.log(`  [Integrated-DRY-RUN] 弹窗未完全关闭，但派件员 input 已回填"${fallbackValue}"，视为选择成功`);
    } else {
      console.log(`  [Integrated-DRY-RUN] "选择派件员"弹窗未关闭且 input 未回填（value="${fallbackValue}"），"使用"按钮可能未生效`);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      return false;
    }
  } else {
    console.log(`  [Integrated-DRY-RUN] "选择派件员"弹窗已关闭`);
  }

  // 验证派件员 input 回填的姓名与传入 courierName 一致
  const courierInputValue = await page.locator(INTEGRATED_SCAN_SELECTORS.courierSelectInput).first()
    .inputValue().catch(() => '');
  if (courierInputValue === courierName) {
    console.log(`  [Integrated-DRY-RUN] 派件员 input 回填验证通过: ${courierInputValue}`);
    return true;
  } else {
    console.log(`  [Integrated-DRY-RUN] 派件员 input 回填值="${courierInputValue}" 与 courierName="${courierName}" 不一致（弹窗已关闭，但校验未通过）`);
    return false;
  }
}
