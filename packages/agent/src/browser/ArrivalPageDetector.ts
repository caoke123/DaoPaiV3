/**
 * ArrivalPageDetector — 到件扫描页面检测
 *
 * Phase 5-D: 检测到件扫描页面核心 DOM 元素。
 *
 * 只检测，不操作。不点击任何按钮，尤其是最终提交按钮。
 */

import type { Page } from 'playwright-core';

export interface ArrivalPageDetectResult {
  url: string;
  title: string;
  isArrivalPage: boolean;
  hasWaybillInput: boolean;
  hasPrevStationInput: boolean;
  hasSearchButton: boolean;
  hasTable: boolean;
  hasFinalSubmitButton: boolean;
  matchedSelectors: string[];
  finalSubmitSelectors: string[];
  warnings: string[];
}

// 到件扫描页面 URL 路径
const ARRIVAL_URL_PATTERNS = [
  '/scanning/ArrivalscanBatch',
  '/scanning/arrivalscanBatch',
  'ArrivalscanBatch',
];

// 到件页面关键词
const ARRIVAL_PAGE_KEYWORDS = [
  '到件扫描', '到件', '批量到件', '运单号', '上一站',
];

// 运单输入框选择器（从短到长，优先匹配简单的）
const WAYBILL_INPUT_SELECTORS = [
  'textarea[placeholder*="运单"]',
  'textarea[placeholder*="输入"]',
  '#app textarea',
  'textarea',
];

// 上一站输入框选择器
const PREV_STATION_SELECTORS = [
  'input[placeholder*="上一站"]',
  'input[placeholder*="站点"]',
  '#app .el-input--suffix input',
];

// 查询按钮选择器（el-button--primary）
const SEARCH_BUTTON_SELECTORS = [
  'button.el-button--primary',
  'button.el-button--primary.el-button--medium',
];

// 表格选择器
const TABLE_SELECTORS = [
  '.el-table__body-wrapper .el-table__row',
  '.el-table__body-wrapper',
  '.el-table',
];

// 最终提交按钮选择器（el-button--danger = 批量到件）
const FINAL_SUBMIT_SELECTORS = [
  'button.el-button--danger',
  'button.el-button--danger.el-button--medium',
];

// 最终提交按钮关键词（用于文本匹配）
const FINAL_SUBMIT_KEYWORDS = [
  '批量到件', '确认到件', '提交到件', '提交', '到件', '批量', '确认',
];

/**
 * 检测到件扫描页面核心 DOM
 */
export async function detectArrivalPage(page: Page): Promise<ArrivalPageDetectResult> {
  const url = page.url();
  const title = await page.title();
  const bodyText = await page.evaluate(() => {
    const body = document.body;
    return body ? body.innerText.substring(0, 1000) : '';
  });

  const warnings: string[] = [];
  const matchedSelectors: string[] = [];
  const finalSubmitSelectors: string[] = [];

  // 1. 判断是否疑似到件扫描页面
  const urlMatch = ARRIVAL_URL_PATTERNS.some(p => url.includes(p));
  const keywordMatch = ARRIVAL_PAGE_KEYWORDS.some(kw => bodyText.includes(kw));
  const isArrivalPage = urlMatch || keywordMatch;

  if (!isArrivalPage) {
    warnings.push('当前页面不是到件扫描页面');
  }

  // 2. 检测运单输入框
  let hasWaybillInput = false;
  for (const sel of WAYBILL_INPUT_SELECTORS) {
    try {
      const count = await page.$$eval(sel, els => els.length);
      if (count > 0) {
        hasWaybillInput = true;
        matchedSelectors.push(`运单输入框: ${sel}`);
        break;
      }
    } catch {
      // 选择器无效，跳过
    }
  }

  // 3. 检测上一站输入框
  let hasPrevStationInput = false;
  for (const sel of PREV_STATION_SELECTORS) {
    try {
      const count = await page.$$eval(sel, els => els.length);
      if (count > 0) {
        hasPrevStationInput = true;
        matchedSelectors.push(`上一站: ${sel}`);
        break;
      }
    } catch {
      // 选择器无效，跳过
    }
  }

  // 4. 检测查询按钮
  let hasSearchButton = false;
  for (const sel of SEARCH_BUTTON_SELECTORS) {
    try {
      const count = await page.$$eval(sel, els => els.length);
      if (count > 0) {
        hasSearchButton = true;
        matchedSelectors.push(`查询按钮: ${sel}`);
        break;
      }
    } catch {
      // 选择器无效，跳过
    }
  }

  // 5. 检测结果表格
  let hasTable = false;
  for (const sel of TABLE_SELECTORS) {
    try {
      const count = await page.$$eval(sel, els => els.length);
      if (count > 0) {
        hasTable = true;
        matchedSelectors.push(`表格: ${sel}`);
        break;
      }
    } catch {
      // 选择器无效，跳过
    }
  }

  // 6. 检测最终提交按钮（检测但不点击）
  let hasFinalSubmitButton = false;
  for (const sel of FINAL_SUBMIT_SELECTORS) {
    try {
      const count = await page.$$eval(sel, els => els.length);
      if (count > 0) {
        // 进一步检查按钮文本是否包含提交关键词
        const btnText = await page.$$eval(sel, els =>
          els.map(el => (el as HTMLElement).textContent || '').join('|')
        );
        const hasKeyword = FINAL_SUBMIT_KEYWORDS.some(kw => btnText.includes(kw));
        if (hasKeyword) {
          hasFinalSubmitButton = true;
          finalSubmitSelectors.push(`提交按钮: ${sel} (文本: ${btnText.substring(0, 50)})`);
        }
      }
    } catch {
      // 选择器无效，跳过
    }
  }

  return {
    url,
    title,
    isArrivalPage,
    hasWaybillInput,
    hasPrevStationInput,
    hasSearchButton,
    hasTable,
    hasFinalSubmitButton,
    matchedSelectors,
    finalSubmitSelectors,
    warnings,
  };
}
