import { promises as fs } from 'fs';
import { Page } from 'playwright';
import { Prov } from './types';


export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function rand(min: number, max: number) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export async function ensureDir(d: string) {
  await fs.mkdir(d, { recursive: true });
}

export async function safeGoto(page: Page, url: string, timeout: number) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  } catch {}
}

export async function screenshotDataUri(page: Page, url: string, vw: number, vh: number, timeout: number, fullPage: boolean) {
  await page.setViewportSize({ width: vw, height: vh });
  await safeGoto(page, url, timeout);

  const buf = await page.screenshot({ fullPage });
  return `data:image/png;base64,${buf.toString('base64')}`;
}

export async function yoloWrite(
  labelPath: string,
  cls: number,
  rect: { x: number; y: number; width: number; height: number },
  vw: number,
  vh: number
) {
  const xC = (rect.x + rect.width / 2) / vw;
  const yC = (rect.y + rect.height / 2) / vh;
  const w = rect.width / vw; const h = rect.height / vh;
  await fs.writeFile(labelPath, `${cls} ${xC.toFixed(6)} ${yC.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}\n`, 'utf-8');
}

// Подложить фон (data:uri) в <img id="bgImg">
export async function setBackgroundImage(page: Page, dataUri: string) {
  await page.evaluate((data) => {
    const img = document.getElementById('bgImg') as HTMLImageElement | null;
    if (img) img.src = data;
  }, dataUri);
}

// Ждём iframe по селектору и проверяем, что у него есть bbox
export async function waitForVisibleFrame(page: Page, selector: string, timeout: number) {
  try {
    await page.waitForSelector(selector, { timeout });
    const bb = await page.locator(selector).first().boundingBox();
    if (bb && bb.width > 0 && bb.height > 0) return bb;
  } catch {}

  return null;
}

// bbox внешней обёртки (наш контейнер .cap-wrapper)
export async function getWrapperBBox(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('.cap-wrapper') as HTMLElement | null;

    if (!el) return null;
    
    const r = el.getBoundingClientRect();

    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  });
}

// bbox челленджа (внутренний iframe) — если есть
export async function getChallengeBBox(page: Page, prov: Prov) {
  const sel =
    prov === 'hcaptcha'
      ? 'iframe[src*="hcaptcha"][title*="challenge"], iframe[title*="hCaptcha challenge"]'
      : prov === 'recaptcha'
      ? 'iframe[src*="api2/bframe"]'
      : '';
  if (!sel) return null;

  const lf = page.locator(sel).first();
  const bb = await lf.boundingBox().catch(() => null);
  
  if (!bb) return null;

  return {
    x: Math.round(bb.x),
    y: Math.round(bb.y),
    width: Math.round(bb.width),
    height: Math.round(bb.height),
  };
}
