import { Page } from 'playwright';

// hCaptcha: клики в типичные точки, проверка появления challenge iframe
export async function tryOpenHcaptcha(page: Page, afterClickDelayMs: number, providerIframeMs: number): Promise<boolean> {
  const sel = 'iframe[src*="hcaptcha"]';
  await page.waitForSelector(sel, { timeout: providerIframeMs }).catch(() => {});
  const ifr = page.locator(sel).first();
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
    const opened = (await page
      .locator('iframe[src*="hcaptcha"][title*="challenge"], iframe[title*="hCaptcha challenge"]')
      .count()
      .catch(() => 0)) > 0;
    if (opened) return true;
  }
  return false;
}

// reCAPTCHA v2 checkbox: ищем api2/anchor; успех — появление api2/bframe
export async function tryOpenRecaptchaV2(page: Page, afterClickDelayMs: number, providerIframeMs: number): Promise<boolean> {
  const anchorSel = 'iframe[src*="api2/anchor"]';
  await page.waitForSelector(anchorSel, { timeout: providerIframeMs }).catch(() => {});
  const ifr = page.locator(anchorSel).first();
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
    const challenge = await page.locator('iframe[src*="api2/bframe"]').count().catch(() => 0);
    if (challenge > 0) return true;
  }
  return false;
}

// Turnstile: отдельный challenge встречается редко — кликаем по центру iframe
export async function tryOpenTurnstile(page: Page, afterClickDelayMs: number, providerIframeMs: number): Promise<boolean> {
  const sel = 'iframe[src*="challenges.cloudflare.com"]';
  await page.waitForSelector(sel, { timeout: providerIframeMs }).catch(() => {});
  const ifr = page.locator(sel).first();
  const bb = await ifr.boundingBox().catch(() => null);
  if (!bb) return false;
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.waitForTimeout(afterClickDelayMs);
  return true; // UI обычно меняется в самом iframe
}
