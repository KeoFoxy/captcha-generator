import type { Page } from 'playwright';
import { waitForStableFrame } from './utils.js';

// hCaptcha: клики по вероятным точкам, затем ждём стабильный challenge iframe
export async function tryOpenHcaptcha(page: Page, afterClickDelayMs: number, providerIframeMs: number): Promise<boolean> {
  const widgetSel = [
    'iframe[title*="hcaptcha" i]',
    'iframe[src*="hcaptcha.com" i]'
  ];
  await waitForStableFrame(page, widgetSel, { timeout: providerIframeMs, minArea: 1800, stableMs: 200 }).catch(() => null);

  const ifr = page.locator(widgetSel.join(', ')).first();
  const bb = await ifr.boundingBox().catch(() => null);
  if (!bb) return false;

  const pts = [
    { x: bb.x + 18, y: bb.y + 18 },
    { x: bb.x + Math.min(28, bb.width / 4), y: bb.y + bb.height / 2 },
    { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }
  ];

  for (const p of pts) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(afterClickDelayMs);

    const ch = await waitForStableFrame(page, [
      'iframe[title*="hcaptcha challenge" i]',
      'iframe[title*="challenge" i][src*="hcaptcha.com" i]'
    ], { timeout: 3000, minArea: 10000, stableMs: 250 });

    if (ch) return true;
  }

  // легкий «дожим» по центру
  if (bb) {
    await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.waitForTimeout(afterClickDelayMs);
    const ch2 = await waitForStableFrame(page, [
      'iframe[title*="hcaptcha challenge" i]',
      'iframe[title*="challenge" i][src*="hcaptcha.com" i]'
    ], { timeout: 2000, minArea: 10000, stableMs: 250 });
    if (ch2) return true;
  }
  return false;
}

// reCAPTCHA v2: клик по anchor → ждем bframe
export async function tryOpenRecaptchaV2(page: Page, afterClickDelayMs: number, providerIframeMs: number): Promise<boolean> {
  const anchorSel = ['iframe[src*="api2/anchor"]', 'iframe[title="reCAPTCHA"]'];
  await waitForStableFrame(page, anchorSel, { timeout: providerIframeMs, minArea: 1800, stableMs: 200 }).catch(() => null);

  const ifr = page.locator(anchorSel.join(', ')).first();
  const bb = await ifr.boundingBox().catch(() => null);
  if (!bb) return false;

  const pts = [
    { x: bb.x + 18, y: bb.y + 18 },
    { x: bb.x + 30, y: bb.y + bb.height / 2 },
    { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }
  ];

  for (const p of pts) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(afterClickDelayMs);
    const ch = await waitForStableFrame(page, ['iframe[src*="api2/bframe"]'], { timeout: 3000, minArea: 10000, stableMs: 250 });
    if (ch) return true;
  }
  return false;
}

// Turnstile: чаще без отдельного challenge — важно стабилизировать сам виджет
export async function tryOpenTurnstile(page: Page, afterClickDelayMs: number, providerIframeMs: number): Promise<boolean> {
  const widgetSel = [
    'iframe[src*="challenges.cloudflare.com" i]',
    'iframe[id^="cf-chl-widget-"]',
    'iframe[title*="cloudflare" i]'
  ];
  const ok = await waitForStableFrame(page, widgetSel, { timeout: providerIframeMs, minArea: 1800, stableMs: 250 });
  if (ok) return true;

  // фолбэк: ткнуть по центру и проверить ещё раз
  const ifr = page.locator(widgetSel.join(', ')).first();
  const bb = await ifr.boundingBox().catch(() => null);
  if (!bb) return false;

  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.waitForTimeout(afterClickDelayMs);

  const ok2 = await waitForStableFrame(page, widgetSel, { timeout: 2000, minArea: 1800, stableMs: 250 });
  return !!ok2;
}
