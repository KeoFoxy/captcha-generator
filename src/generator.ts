import { chromium, Page, BrowserContext } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';

// ====== CONFIG ======
const RENDER_URL_BASE = 'https://keofoxy.github.io/captcha-generator/index.html';

const CONFIG = {
  outDir: 'out',
  viewport: { width: 1280, height: 800 },

  // ФОНЫ: чем меньше уникальных URL — тем быстрее (кэшируем скрины)
  backgrounds: [
    'https://www.wikipedia.org/',
    'https://developer.mozilla.org/',
  ],

  // ПРОВАЙДЕРЫ: сколько примеров каждого (count — это "кейсов", а не файлов; если capture='both', будет по 2 файла на кейс)
  providers: [
    { name: 'hcaptcha'  as const, count: 500, size: 'normal', variant: 'checkbox', openChallenge: true  },
    { name: 'turnstile' as const, count: 500, size: 'auto',   variant: 'interactive', openChallenge: false },
    { name: 'recaptcha' as const, count: 300, size: 'normal', variant: 'checkbox', openChallenge: true  }, // v2 checkbox
  ],

  // РАЗМЕТКА/ДАТАСЕТ
  split: { train: 0.8, val: 0.1, test: 0.1 },  // вероятности раскладки в подпапки
  yolo: true,                                   // писать ли YOLO .txt (bbox контейнера-обёртки)
  includeChallengeBBox: true,                   // доп. bbox раскрытого окна челленджа (post) в meta.json

  // КАДРЫ
  capture: 'both' as 'pre' | 'post' | 'both',   // что снимать: до клика, после, или оба
  fullPage: false,                              // fullPage=true медленнее; false = скрин в пределах viewport
  positions: { x: { min: 24, max: 980 }, y: { min: 96, max: 640 } },
  randomize: { theme: ['light','dark'] as const, languages: ['en','ru','es'], jitter: 6 },

  // ПРОИЗВОДИТЕЛЬНОСТЬ
  concurrency: 6,                               // кол-во параллельных воркеров/страниц
  disableIframeBackground: true,                // не грузить bgUrl во фрейм (экономит сеть) — используем только картинку
  retries: 1,                                   // на случай флаки — переиграть задачу

  // ТАЙМАУТЫ
  timeouts: {
    pageLoadMs: 15000,        // ниже = быстрее; если GH Pages иногда тупит — чуть подними
    providerIframeMs: 8000,
    afterClickDelayMs: 800
  }
} as const;

// ====== КЛАССЫ / ТИПЫ ======
type Prov = 'recaptcha'|'hcaptcha'|'turnstile';
const CLASS_ID: Record<Prov, number> = { recaptcha:0, hcaptcha:1, turnstile:2 };

function pick<T>(arr: readonly T[]): T { return arr[Math.floor(Math.random()*arr.length)]; }
function rand(min:number,max:number){ return min + Math.floor(Math.random()*(max-min+1)); }
async function ensureDir(d:string){ await fs.mkdir(d,{recursive:true}); }

async function safeGoto(page: Page, url: string, timeout: number) {
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout }); }
  catch { /* ок, оставим как есть */ }
}

async function screenshotDataUri(page: Page, url: string, vw: number, vh: number, timeout: number) {
  await page.setViewportSize({ width: vw, height: vh });
  await safeGoto(page, url, timeout);
  const buf = await page.screenshot({ fullPage: CONFIG.fullPage });
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

// ====== TASKS / WORKERS ======
type Task = { prov: Prov, pCfg: any, idx: number };

function makeTasks() {
  const tasks: Task[] = [];
  for (const p of CONFIG.providers) {
    for (let i=0; i<p.count; i++) tasks.push({ prov: p.name, pCfg: p, idx: i });
  }
  // простая перемешка для равномерности
  for (let i=tasks.length-1; i>0; i--) { const j = Math.floor(Math.random()*(i+1)); [tasks[i], tasks[j]] = [tasks[j], tasks[i]]; }
  return tasks;
}

function chooseSplitDir() {
  const r = Math.random();
  return r < CONFIG.split.train ? 'train' : (r < CONFIG.split.train + CONFIG.split.val ? 'val' : 'test');
}

async function prepareBgCache(ctx: BrowserContext, vw:number, vh:number) {
  const page = await ctx.newPage();
  const cache = new Map<string,string>();
  for (const url of Array.from(new Set(CONFIG.backgrounds))) {
    try {
      const data = await screenshotDataUri(page, url, vw, vh, CONFIG.timeouts.pageLoadMs);
      cache.set(url, data);
      process.stdout.write(`[bg cached] ${url}\n`);
    } catch (e:any) {
      console.error('[bg fail]', url, e?.message || e);
    }
  }
  await page.close().catch(()=>{});
  return cache;
}

async function runOne(page: Page, bgCache: Map<string,string>, p: Task, globalIdx: number) {
  // случайные параметры кадра
  const bgUrl = CONFIG.backgrounds[rand(0, CONFIG.backgrounds.length-1)];
  const bgData = bgCache.get(bgUrl)!;

  const x0 = rand(CONFIG.positions.x.min, CONFIG.positions.x.max);
  const y0 = rand(CONFIG.positions.y.min, CONFIG.positions.y.max);
  const j = CONFIG.randomize.jitter;
  const x = x0 + (j ? rand(-j,j) : 0);
  const y = y0 + (j ? rand(-j,j) : 0);
  const theme = pick(CONFIG.randomize.theme);
  const hl = pick(CONFIG.randomize.languages);

  // загрузить рендер
  const u = new URL(RENDER_URL_BASE);
  u.searchParams.set('prov', p.prov as any);
  u.searchParams.set('size', p.pCfg.size || 'normal');
  u.searchParams.set('variant', p.pCfg.variant || 'checkbox');
  u.searchParams.set('theme', theme);
  u.searchParams.set('hl', hl);
  u.searchParams.set('x', String(x));
  u.searchParams.set('y', String(y));
  if (!CONFIG.disableIframeBackground) u.searchParams.set('bgUrl', bgUrl);

  await safeGoto(page, u.toString(), CONFIG.timeouts.pageLoadMs);

  // подложить картинку фона (без сети)
  await page.evaluate((dataUri) => {
    const img = document.getElementById('bgImg') as HTMLImageElement | null;
    if (img) img.src = dataUri;
  }, bgData);

  // дождаться виджета
  const waitSel =
    p.prov === 'hcaptcha'  ? 'iframe[src*="hcaptcha"]' :
    p.prov === 'turnstile' ? 'iframe[src*="challenges.cloudflare.com"]' :
                             'iframe[src*="api2/anchor"]'; // recaptcha v2 anchor
  await page.waitForSelector(waitSel, { timeout: CONFIG.timeouts.providerIframeMs }).catch(()=>{});

  // раскладка по подпапкам
  const baseOut = path.join(CONFIG.outDir, p.prov, chooseSplitDir());
  await ensureDir(baseOut);
  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  const stemBase = `${ts}_${String(globalIdx).padStart(6,'0')}`;

  // PRE
  let preRect;
  if (CONFIG.capture === 'pre' || CONFIG.capture === 'both') {
    preRect = await getWrapperBBox(page);
    const prePng = path.join(baseOut, `${stemBase}_pre.png`);
    const preMeta = path.join(baseOut, `${stemBase}_pre.json`);
    const preYolo = path.join(baseOut, `${stemBase}_pre.txt`);
    await page.screenshot({ path: prePng, fullPage: CONFIG.fullPage });
    if (CONFIG.yolo && preRect) await yoloWrite(preYolo, CLASS_ID[p.prov], preRect, CONFIG.viewport.width, CONFIG.viewport.height);
    await fs.writeFile(preMeta, JSON.stringify({
      provider: p.prov, variant: p.pCfg.variant||null, size: p.pCfg.size||'normal',
      state: 'pre', theme, lang: hl, backgroundUrl: bgUrl,
      position: {x,y}, viewport: CONFIG.viewport, bbox: preRect, createdAt: new Date().toISOString()
    }, null, 2));
  }

  // POST (с попыткой открыть челлендж)
  if (CONFIG.capture === 'post' || CONFIG.capture === 'both') {
    let opened = false;
    if (p.prov === 'hcaptcha' && p.pCfg.openChallenge) opened = await tryOpenHcaptcha(page);
    else if (p.prov === 'recaptcha' && p.pCfg.openChallenge) opened = await tryOpenRecaptchaV2(page);
    else if (p.prov === 'turnstile' && p.pCfg.openChallenge) {
      const ifr = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
      const bb = await ifr.boundingBox().catch(()=>null);
      if (bb) {
        await page.mouse.click(bb.x + bb.width/2, bb.y + bb.height/2);
        await page.waitForTimeout(CONFIG.timeouts.afterClickDelayMs);
        opened = true;
      }
    }

    const postRect = await getWrapperBBox(page);
    const postPng = path.join(baseOut, `${stemBase}_post.png`);
    const postMeta = path.join(baseOut, `${stemBase}_post.json`);
    const postYolo = path.join(baseOut, `${stemBase}_post.txt`);
    const challengeRect = CONFIG.includeChallengeBBox ? await getChallengeBBox(page, p.prov) : null;

    await page.screenshot({ path: postPng, fullPage: CONFIG.fullPage });
    if (CONFIG.yolo && postRect) await yoloWrite(postYolo, CLASS_ID[p.prov], postRect, CONFIG.viewport.width, CONFIG.viewport.height);
    await fs.writeFile(postMeta, JSON.stringify({
      provider: p.prov, variant: p.pCfg.variant||null, size: p.pCfg.size||'normal',
      state: 'post', challengeOpened: opened, challengeBBox: challengeRect,
      theme, lang: hl, backgroundUrl: bgUrl,
      position: {x,y}, viewport: CONFIG.viewport, bbox: postRect, createdAt: new Date().toISOString()
    }, null, 2));
  }
}

(async () => {
  await ensureDir(CONFIG.outDir);
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage'] // полезно в Docker/WSL
  });
  const ctx = await browser.newContext({ viewport: CONFIG.viewport });

  // 1) кешируем фоновые скрины (быстро, 1 вкладка)
  const bgCache = await prepareBgCache(ctx, CONFIG.viewport.width, CONFIG.viewport.height);

  // 2) готовим очередь задач
  const tasks = makeTasks();
  let cursor = 0;
  let globalIdx = 0;

  // 3) пулы воркеров — страница реюзится, навигация только на renderer (быстро)
  async function worker(wid: number) {
    const page = await ctx.newPage();
    while (true) {
      const myIdx = cursor++;
      if (myIdx >= tasks.length) break;

      const t = tasks[myIdx];
      let attempt = 0;
      while (attempt <= CONFIG.retries) {
        try {
          await runOne(page, bgCache, t, globalIdx++);
          break;
        } catch (e:any) {
          attempt++;
          if (attempt > CONFIG.retries) {
            console.error(`[worker ${wid}] task failed after retries:`, e?.message || e);
          } else {
            await page.waitForTimeout(300); // маляяяенькая пауза и пробуем снова
          }
        }
      }
    }
    await page.close().catch(()=>{});
  }

  const workers = Array.from({length: CONFIG.concurrency}, (_,i)=>worker(i));
  await Promise.all(workers);

  await ctx.close();
  await browser.close();
  console.log('All done.');
})();
