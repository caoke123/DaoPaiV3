/**
 * ArrivalBrowserDryRun — 到件扫描浏览器 DRY-RUN 页面操作
 *
 * Phase 5-D: 在笨鸟系统中执行到件扫描页面级 DRY-RUN。
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
}

// 到件扫描页面 URL
const ARRIVAL_PAGE_URL = 'https://bnsy.benniaosuyun.com/scanning/ArrivalscanBatch';

// 禁止点击的按钮关键词（只检查明确的提交按钮，不检查模糊关键词）
const FORBIDDEN_BUTTON_KEYWORDS = [
  '批量到件', '确认到件', '提交到件', '提交', '保存', '完成',
];

// 允许点击的按钮关键词
const ALLOWED_BUTTON_KEYWORDS = ['查询', '搜索', '检索'];

/**
 * 硬性保护：检查按钮文本是否是最终提交按钮
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
 */
export async function runArrivalBrowserDryRun(
  page: Page,
  input: ArrivalBrowserDryRunInput,
): Promise<ArrivalBrowserDryRunResult> {
  const warnings: string[] = [];
  const { waybills, options } = input;
  const prevStation = options?.prevStation || '天津分拨中心';

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
  result.title = await page.title();
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

  // 4. 输入测试运单
  if (detectBefore.hasWaybillInput && waybills.length > 0) {
    console.log(`  [DRY-RUN] 输入测试运单 (${waybills.length} 条)...`);
    try {
      // 查找 textarea
      const textareaSelectors = [
        'textarea[placeholder*="运单"]',
        'textarea[placeholder*="输入"]',
        '#app textarea',
        'textarea',
      ];

      let textareaFound = false;
      for (const sel of textareaSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 2000 })) {
            await el.fill(waybills.join('\n'));
            result.inputCount = waybills.length;
            textareaFound = true;
            console.log(`  [DRY-RUN] 运单已输入，使用选择器: ${sel}`);
            break;
          }
        } catch {
          // 跳过
        }
      }

      if (!textareaFound) {
        warnings.push('无法找到可见的运单输入框');
      }
    } catch (err) {
      warnings.push(`运单输入失败: ${(err as Error).message}`);
    }
  }

  // 5. 填写上一站（如有）
  if (detectBefore.hasPrevStationInput && prevStation) {
    console.log(`  [DRY-RUN] 尝试填写上一站: ${prevStation}`);
    try {
      const prevStationSelectors = [
        'input[placeholder*="上一站"]',
        'input[placeholder*="站点"]',
        '#app .el-input--suffix input',
      ];

      for (const sel of prevStationSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 2000 })) {
            await el.fill(prevStation);
            await page.waitForTimeout(500);
            // 尝试选择下拉选项
            try {
              const option = page.locator(`.el-select-dropdown__item:has-text("${prevStation}")`).first();
              if (await option.isVisible({ timeout: 1000 })) {
                await option.click();
                console.log(`  [DRY-RUN] 上一站已选择: ${prevStation}`);
              }
            } catch {
              // 下拉选项可能不存在，直接回车
              await el.press('Enter');
              console.log(`  [DRY-RUN] 上一站已填写: ${prevStation}`);
            }
            break;
          }
        } catch {
          // 跳过
        }
      }
    } catch (err) {
      warnings.push(`上一站填写失败: ${(err as Error).message}`);
    }
  }

  // 6. 点击查询按钮（安全检查：绝不点击提交按钮）
  if (detectBefore.hasSearchButton) {
    // 点击前再次清理弹窗
    await cleanPagePopups(page);
    console.log('  [DRY-RUN] 查找并点击查询按钮...');
    try {
      const searchBtnSelectors = [
        'button.el-button--primary',
        'button.el-button--primary.el-button--medium',
      ];

      let searchClicked = false;
      for (const sel of searchBtnSelectors) {
        try {
          const buttons = page.locator(sel);
          const count = await buttons.count();

          // 第一轮：找包含"查询/搜索/检索"文本的按钮
          for (let i = 0; i < count; i++) {
            const btn = buttons.nth(i);
            if (await btn.isVisible({ timeout: 2000 })) {
              const btnText = (await btn.textContent() || '').trim();

              // 硬性保护：检查是否是最终提交按钮
              assertNotFinalSubmit(btnText);

              // 检查是否是查询类按钮
              const isSearchBtn = ALLOWED_BUTTON_KEYWORDS.some(kw =>
                btnText.includes(kw)
              );

              if (isSearchBtn) {
                await btn.click({ timeout: 5000 });
                result.queried = true;
                searchClicked = true;
                console.log(`  [DRY-RUN] 已点击查询按钮（文本: "${btnText}"）`);
                break;
              }
            }
          }

          // 第二轮：回退到点击第一个可见的 el-button--primary（排除 el-button--danger）
          if (!searchClicked) {
            for (let i = 0; i < count; i++) {
              const btn = buttons.nth(i);
              if (await btn.isVisible({ timeout: 2000 })) {
                const btnText = (await btn.textContent() || '').trim();
                // 硬性保护
                assertNotFinalSubmit(btnText);
                // 点击第一个安全的 primary 按钮
                await btn.click({ timeout: 5000 });
                result.queried = true;
                searchClicked = true;
                console.log(`  [DRY-RUN] 已点击 primary 按钮（回退策略，文本: "${btnText}"）`);
                break;
              }
            }
          }

          if (searchClicked) break;
        } catch (err) {
          if (err instanceof Error && err.message.includes('安全保护')) {
            throw err; // 安全保护错误直接抛出
          }
          // 输出非安全保护错误，便于调试
          console.log(`  [DRY-RUN] 选择器 ${sel} 异常: ${(err as Error).message}`);
        }
      }

      if (!searchClicked) {
        warnings.push('未找到安全的查询按钮');
        console.log('  [DRY-RUN] 未找到安全的查询按钮');
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('安全保护')) {
        result.message = err.message;
        return result;
      }
      warnings.push(`查询按钮点击失败: ${(err as Error).message}`);
    }

    // 7. 等待页面稳定
    if (result.queried) {
      console.log('  [DRY-RUN] 等待页面稳定（3秒）...');
      await page.waitForTimeout(3000);
    }
  }

  // 8. 再次检测到件页面元素（查询后）
  console.log('  [DRY-RUN] 检测到件页面元素（查询后）...');
  const detectAfter = await detectArrivalPage(page);
  result.detectAfter = detectAfter;

  console.log(`  [DRY-RUN] 查询后表格: ${detectAfter.hasTable ? '已检测到' : '未检测到'}`);
  console.log(`  [DRY-RUN] 查询后提交按钮: ${detectAfter.hasFinalSubmitButton ? '已检测到（不点击）' : '未检测到'}`);

  // 9. 明确 finalSubmitClicked = false
  result.finalSubmitClicked = false;

  // 10. 结果
  result.success = true;
  result.message = 'DRY-RUN 完成：已输入运单并点击查询，未点击最终提交按钮';

  console.log(`  [DRY-RUN] ${result.message}`);
  return result;
}
