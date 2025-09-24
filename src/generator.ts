import { chromium, Page } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';

const RENDER_URL_BASE = 'https://keofoxy.github.io/captcha-generator/index.html';

const CONFIG = {
  outDir: 'out',
  viewport: { width: 1280, height: 800 },
  backgrounds: [
    'https://www.wikipedia.org/',
    'https://developer.mozilla.org/',
  ],
  providers: [
    { name: 'hcaptcha'  as const, count: 20, size: 'normal', variant: 'checkbox', openChallenge: true  },
    { name: 'turnstile' as const, count: 20, size: 'auto',   variant: 'interactive', openChallenge: false },
    { name: 'recaptcha' as const, count: 10, size: 'normal', variant: 'checkbox', openChallenge: true  }, // v2 Checkbox
  ],
  positions: { x: { min: 24, max: 980 }, y: { min: 96, max: 640 } },
  randomize: { theme: ['light','dark'] as const, languages: ['en','ru','es'], jitter: 6 },
  split: { train: 0.8, val: 0.1, test: 0.1 },
  yolo: true,
  timeouts: {
    pageLoadMs: 45000,
    providerIframeMs: 15000,
    afterClickDelayMs: 1200
  }
};

type Prov = 'recaptcha'|'hcaptcha'|'turnstile';
const CLASS_ID: Record<Prov, number> = { recaptcha:0, hcaptcha:1, turnstile:2 };

function pick<T>(arr: readonly T[]): T { return arr[Math.floor(Math.random()*arr.length)]; }
function rand(min:number,max:number){ return min + Math.floor(Math.random()*(max-min+1)); }
async function ensureDir(d:string){ await fs.mkdir(d,{recursive:true}); }

async function safeGoto(page: Page, url: string, timeout: number) {
  try { await page.goto(url, { waitUntil: 'load', timeout }); }
  catch { try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout }); } catch {}
  }
}

async function screenshotDataUri(page: Page, url: string, vw: number, vh: number, timeout: number) {
  await page.setViewportSize({ width: vw, height: vh });
  await safeGoto(page, url, timeout);
  const buf = await page.screenshot({ fullPage: true });
  return `data:image/png;base64,${buf.toString('base64')}`;
}

async function yoloWrite(labelPath: string, cls: number, rect: {x:number;y:number;width:number;height:number}, vw:number, vh:number) {
  const xC = (rect.x + rect.width/2) / vw;
  const yC = (rect.y + rect.height/2) / vh;
  const w = rect.width / vw; const h = rect.height / vh;
  await fs.writeFile(labelPath, `${cls} ${xC.toFixed(6)} ${yC.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}\n`, 'utf-8');
}

// ---- helpers to open challenges & get rects ----
async function tryOpenHcaptcha(page: Page): Promise<boolean> {
  const sel = 'iframe[src*="hcaptcha"]';
  await page.waitForSelector(sel, { timeout: CONFIG.timeouts.providerIframeMs }).catch(()=>{});
  const ifr = page.locator(sel).first();
  const bb = await ifr.boundingBox().catch(()=>null);
  if (!bb) return false;

  // несколько точек (чекбокс обычно слева-сверху)
  const pts = [
    { x: bb.x + 18, y: bb.y + 18 },
    { x: bb.x + Math.min(28, bb.width/4), y: bb.y + bb.height/2 },
    { x: bb.x + bb.width/2, y: bb.y + bb.height/2 },
  ];
  for (const p of pts) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(CONFIG.timeouts.afterClickDelayMs);
    const opened =
      (await page.locator('iframe[src*="hcaptcha"][title*="challenge"], iframe[title*="hCaptcha challenge"]').count().catch(()=>0)) > 0;
    if (opened) return true;
  }
  return false;
}

async function tryOpenRecaptchaV2(page: Page): Promise<boolean> {
  const anchorSel = 'iframe[src*="api2/anchor"]';
  await page.waitForSelector(anchorSel, { timeout: CONFIG.timeouts.providerIframeMs }).catch(()=>{});
  const ifr = page.locator(anchorSel).first();
  const bb = await ifr.boundingBox().catch(()=>null);
  if (!bb) return false;

  const pts = [
    { x: bb.x + 18, y: bb.y + 18 },
    { x: bb.x + 30, y: bb.y + bb.height/2 },
    { x: bb.x + bb.width/2, y: bb.y + bb.height/2 },
  ];
  for (const p of pts) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(CONFIG.timeouts.afterClickDelayMs);
    const challenge = await page.locator('iframe[src*="api2/bframe"]').count().catch(()=>0);
    if (challenge > 0) return true;
  }
  return false;
}

async function getWrapperBBox(page: Page) {
  return page.evaluate(() => {
    const el = document.querySelector('.cap-wrapper') as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  });
}

async function getChallengeBBox(page: Page, prov: Prov) {
  const sel =
    prov === 'hcaptcha'
      ? 'iframe[src*="hcaptcha"][title*="challenge"], iframe[title*="hCaptcha challenge"]'
      : prov === 'recaptcha'
      ? 'iframe[src*="api2/bframe"]'
      : '';
  if (!sel) return null;
  const lf = page.locator(sel).first();
  const bb = await lf.boundingBox().catch(()=>null);
  if (!bb) return null;
  return { x: Math.round(bb.x), y: Math.round(bb.y), width: Math.round(bb.width), height: Math.round(bb.height) };
}
// ------------------------------------------------

(async () => {
  await ensureDir(CONFIG.outDir);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: CONFIG.viewport });

  // вкладка для скринов фона → data:uri
  const bgPage = await ctx.newPage();
  const bgCache = new Map<string,string>();

  let idx = 0;

  for (const p of CONFIG.providers) {
    const baseOut = path.join(CONFIG.outDir, p.name);
    await ensureDir(baseOut);

    for (let i=0;i<p.count;i++){
      const bgUrl = CONFIG.backgrounds[rand(0, CONFIG.backgrounds.length-1)];
      if (!bgCache.has(bgUrl)) {
        const data = await screenshotDataUri(bgPage, bgUrl, CONFIG.viewport.width, CONFIG.viewport.height, CONFIG.timeouts.pageLoadMs);
        bgCache.set(bgUrl, data);
      }
      const bgData = bgCache.get(bgUrl)!;

      const x0 = rand(CONFIG.positions.x.min, CONFIG.positions.x.max);
      const y0 = rand(CONFIG.positions.y.min, CONFIG.positions.y.max);
      const j = CONFIG.randomize.jitter;
      const x = x0 + (j ? rand(-j,j) : 0);
      const y = y0 + (j ? rand(-j,j) : 0);
      const theme = pick(CONFIG.randomize.theme);
      const hl = pick(CONFIG.randomize.languages);

      const page = await ctx.newPage();

      try {
        // 1) загрузить рендер
        const u = new URL(RENDER_URL_BASE);
        u.searchParams.set('prov', p.name as any);
        u.searchParams.set('size', (p as any).size || 'normal');
        u.searchParams.set('variant', (p as any).variant || 'checkbox');
        u.searchParams.set('theme', theme);
        u.searchParams.set('hl', hl);
        u.searchParams.set('x', String(x));
        u.searchParams.set('y', String(y));
        u.searchParams.set('bgUrl', bgUrl);
        await safeGoto(page, u.toString(), CONFIG.timeouts.pageLoadMs);

        // подложить картинку фона
        await page.evaluate((dataUri) => {
          const img = document.getElementById('bgImg') as HTMLImageElement | null;
          if (img) img.src = dataUri;
        }, bgData);

        // дождаться появления виджета (iframe)
        const waitSel =
          p.name === 'hcaptcha'  ? 'iframe[src*="hcaptcha"]' :
          p.name === 'turnstile' ? 'iframe[src*="challenges.cloudflare.com"]' :
                                   'iframe[src*="api2/anchor"]'; // recaptcha v2 anchor
        await page.waitForSelector(waitSel, { timeout: CONFIG.timeouts.providerIframeMs }).catch(()=>{});

        // split dir и имена файлов
        const r = Math.random();
        const split = r < CONFIG.split.train ? 'train' : (r < CONFIG.split.train+CONFIG.split.val ? 'val' : 'test');
        const outDir = path.join(baseOut, split);
        await ensureDir(outDir);
        const ts = new Date().toISOString().replace(/[:.]/g,'-');
        const stemBase = `${ts}_${String(idx).padStart(5,'0')}`;

        // 2) ---- PRE: скрин до клика
        const prePng = path.join(outDir, `${stemBase}_pre.png`);
        const preMeta = path.join(outDir, `${stemBase}_pre.json`);
        const preYolo = path.join(outDir, `${stemBase}_pre.txt`);
        const preRect = await getWrapperBBox(page);
        await page.screenshot({ path: prePng, fullPage: true });
        if (CONFIG.yolo && preRect) await yoloWrite(preYolo, CLASS_ID[p.name], preRect, CONFIG.viewport.width, CONFIG.viewport.height);
        await fs.writeFile(preMeta, JSON.stringify({
          provider: p.name, variant: (p as any).variant||null, size: (p as any).size||'normal',
          state: 'pre', theme, lang: hl, backgroundUrl: bgUrl,
          position: {x,y}, viewport: CONFIG.viewport, bbox: preRect, createdAt: new Date().toISOString()
        }, null, 2));

        // 3) клик, чтобы «раскрыть» challenge (если имеет смысл)
        let opened = false;
        if (p.name === 'hcaptcha' && p.openChallenge) {
          opened = await tryOpenHcaptcha(page);
        } else if (p.name === 'recaptcha' && p.openChallenge) {
          opened = await tryOpenRecaptchaV2(page);
        } else if (p.name === 'turnstile' && p.openChallenge) {
          // у turnstile обычно нет отдельного окна-челленджа,
          // можно просто щёлкнуть по центру виджета, но UI часто не меняется
          const ifr = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
          const bb = await ifr.boundingBox().catch(()=>null);
          if (bb) {
            await page.mouse.click(bb.x + bb.width/2, bb.y + bb.height/2);
            await page.waitForTimeout(CONFIG.timeouts.afterClickDelayMs);
            opened = true;
          }
        }

        // 4) ---- POST: скрин после клика (даже если окно не появилось)
        const postPng = path.join(outDir, `${stemBase}_post.png`);
        const postMeta = path.join(outDir, `${stemBase}_post.json`);
        const postYolo = path.join(outDir, `${stemBase}_post.txt`);
        const postRect = await getWrapperBBox(page);
        const challengeRect = await getChallengeBBox(page, p.name);
        await page.screenshot({ path: postPng, fullPage: true });
        if (CONFIG.yolo && postRect) await yoloWrite(postYolo, CLASS_ID[p.name], postRect, CONFIG.viewport.width, CONFIG.viewport.height);
        await fs.writeFile(postMeta, JSON.stringify({
          provider: p.name, variant: (p as any).variant||null, size: (p as any).size||'normal',
          state: 'post', challengeOpened: opened, challengeBBox: challengeRect,
          theme, lang: hl, backgroundUrl: bgUrl,
          position: {x,y}, viewport: CONFIG.viewport, bbox: postRect, createdAt: new Date().toISOString()
        }, null, 2));

        idx++;
        process.stdout.write(`Saved ${prePng} & ${postPng}\n`);
      } catch (e:any) {
        console.error('[WARN]', e?.message || e);
      } finally {
        await page.close().catch(()=>{});
      }
    }
  }

  await browser.close();
})();
