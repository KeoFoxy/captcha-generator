import { chromium, Page, BrowserContext } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';
import pc from 'picocolors';
import cliProgress from 'cli-progress';

// ----------------------------
// Типы провайдеров и классы
// ----------------------------
type Prov = 'recaptcha'|'hcaptcha'|'turnstile';
const CLASS_ID: Record<Prov, number> = { recaptcha:0, hcaptcha:1, turnstile:2 };

// ----------------------------
// Чтение конфига
// ----------------------------
function getArg(name: string, def?: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i+1] : def;
}

async function readConfig() {
  const configPath = getArg('--config', 'config.json')!;
  const raw = await fs.readFile(configPath, 'utf-8');
  const cfg = JSON.parse(raw);

  // Значения по умолчанию (если чего-то нет в конфиге)
  cfg.outDir ??= 'out';
  cfg.viewport ??= { width: 1280, height: 800 };
  cfg.randomize ??= { theme: ['light','dark'], languages: ['en'], jitter: 0 };
  cfg.split ??= false;                      // false = без подпапок
  cfg.yolo ??= false;                       // YOLO .txt не писать
  cfg.includeChallengeBBox ??= true;
  cfg.capture ??= 'both';                   // pre/post/both
  cfg.fullPage ??= false;
  cfg.concurrency ??= 4;
  cfg.disableIframeBackground ??= true;
  cfg.retries ??= 1;
  cfg.timeouts ??= { pageLoadMs: 15000, providerIframeMs: 8000, afterClickDelayMs: 800 };
  cfg.rendererUrl ??= 'https://keofoxy.github.io/captcha-generator/index.html';

  return cfg as {
    outDir: string;
    viewport: { width:number; height:number };
    backgrounds: string[];
    providers: Array<{ name: Prov; count: number; size: string; variant?: string; openChallenge?: boolean }>;
    positions: { x:{min:number;max:number}; y:{min:number;max:number} };
    randomize: { theme: ('light'|'dark')[]; languages: string[]; jitter: number };
    split: false | { train:number; val:number; test:number };
    yolo: boolean;
    includeChallengeBBox: boolean;
    capture: 'pre'|'post'|'both';
    fullPage: boolean;
    concurrency: number;
    disableIframeBackground: boolean;
    retries: number;
    timeouts: { pageLoadMs:number; providerIframeMs:number; afterClickDelayMs:number };
    rendererUrl: string;
  };
}

// ----------------------------
// Утилиты
// ----------------------------
function pick<T>(arr: readonly T[]): T { return arr[Math.floor(Math.random()*arr.length)]; }
function rand(min:number,max:number){ return min + Math.floor(Math.random()*(max-min+1)); }
async function ensureDir(d:string){ await fs.mkdir(d,{recursive:true}); }

async function safeGoto(page: Page, url: string, timeout: number) {
  // Ставим DOMContentLoaded — для нашего index.html этого достаточно и быстрее
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout }); }
  catch { /* игнорируем единичные фейлы — выше есть ретраи */ }
}

async function screenshotDataUri(page: Page, url: string, vw: number, vh: number, timeout: number, fullPage: boolean) {
  // Делаем скриншот страницы в картинку data:uri (фон), чтобы не грузить iframe на рендерере
  await page.setViewportSize({ width: vw, height: vh });
  await safeGoto(page, url, timeout);
  const buf = await page.screenshot({ fullPage });
  return `data:image/png;base64,${buf.toString('base64')}`;
}

async function yoloWrite(labelPath: string, cls: number, rect: {x:number;y:number;width:number;height:number}, vw:number, vh:number) {
  // YOLO формула: координаты нормализуются к [0..1]
  const xC = (rect.x + rect.width/2) / vw;
  const yC = (rect.y + rect.height/2) / vh;
  const w = rect.width / vw; const h = rect.height / vh;
  await fs.writeFile(labelPath, `${cls} ${xC.toFixed(6)} ${yC.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}\n`, 'utf-8');
}

// ----------------------------
// «Раскрытие» виджетов (клик в iframe)
// ----------------------------
async function tryOpenHcaptcha(page: Page, afterClickDelayMs: number, providerIframeMs: number): Promise<boolean> {
  // Ждём iframe виджета
  const sel = 'iframe[src*="hcaptcha"]';
  await page.waitForSelector(sel, { timeout: providerIframeMs }).catch(()=>{});
  const ifr = page.locator(sel).first();
  const bb = await ifr.boundingBox().catch(()=>null);
  if (!bb) return false;

  // Пробуем кликнуть в типичные точки (чекбокс чаще слева-сверху)
  const pts = [
    { x: bb.x + 18, y: bb.y + 18 },
    { x: bb.x + Math.min(28, bb.width/4), y: bb.y + bb.height/2 },
    { x: bb.x + bb.width/2, y: bb.y + bb.height/2 },
  ];
  for (const p of pts) {
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(afterClickDelayMs);

    // Появление challenge-iframe = успех
    const opened =
      (await page.locator('iframe[src*="hcaptcha"][title*="challenge"], iframe[title*="hCaptcha challenge"]').count().catch(()=>0)) > 0;
    if (opened) return true;
  }
  return false;
}

async function tryOpenRecaptchaV2(page: Page, afterClickDelayMs: number, providerIframeMs: number): Promise<boolean> {
  // Для reCAPTCHA v2 чекбокс — iframe api2/anchor
  const anchorSel = 'iframe[src*="api2/anchor"]';
  await page.waitForSelector(anchorSel, { timeout: providerIframeMs }).catch(()=>{});
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
    await page.waitForTimeout(afterClickDelayMs);

    // Второй iframe api2/bframe = окно с картинками
    const challenge = await page.locator('iframe[src*="api2/bframe"]').count().catch(()=>0);
    if (challenge > 0) return true;
  }
  return false;
}

// ----------------------------
// Получение bbox
// ----------------------------
async function getWrapperBBox(page: Page) {
  // Берём прямоугольник внешней обёртки .cap-wrapper (то, что мы накладываем вокруг виджета)
  return page.evaluate(() => {
    const el = document.querySelector('.cap-wrapper') as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  });
}

async function getChallengeBBox(page: Page, prov: Prov) {
  // Пытаемся найти внутренний фрейм челленджа (если он есть)
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

// ----------------------------
// Очередь задач и прогресс
// ----------------------------
type ProviderCfg = { name: Prov; count: number; size: string; variant?: string; openChallenge?: boolean };
type Task = { prov: Prov, pCfg: ProviderCfg, idx: number };

function makeTasks(providers: ProviderCfg[]) {
  const tasks: Task[] = [];
  for (const p of providers) for (let i=0; i<p.count; i++) tasks.push({ prov: p.name, pCfg: p, idx: i });
  // Перемешиваем, чтобы нагрузка по провайдерам шла ровно
  for (let i=tasks.length-1; i>0; i--) { const j = Math.floor(Math.random()*(i+1)); [tasks[i], tasks[j]] = [tasks[j], tasks[i]]; }
  return tasks;
}

function chooseSplitDir(split: false | {train:number;val:number;test:number}) {
  if (!split) return null; // без подпапок
  const r = Math.random();
  return r < split.train ? 'train' : (r < split.train + split.val ? 'val' : 'test');
}

async function prepareBgCache(ctx: BrowserContext, cfg: any) {
  // Кешируем фоновые скрины (в картинки), чтобы не грузить их каждый раз в renderer
  const page = await ctx.newPage();
  const cache = new Map<string,string>();
  for (const url of Array.from(new Set(cfg.backgrounds))) {
    try {
      const data = await screenshotDataUri(page, url as string, cfg.viewport.width, cfg.viewport.height, cfg.timeouts.pageLoadMs, cfg.fullPage);
      cache.set(url as string, data);
      process.stdout.write(pc.dim(`[bg cached] ${url}\n`));
    } catch (e:any) {
      console.error(pc.red('[bg fail]'), url, e?.message || e);
    }
  }
  await page.close().catch(()=>{});
  return cache;
}

// ----------------------------
// Основная логика «одной задачи»
// ----------------------------
async function runOne(page: Page, bgCache: Map<string,string>, cfg: any, t: Task, globalIdx: number): Promise<number> {
  // 1) Подбираем случайный фон + координаты, тему, язык
  const bgUrl = cfg.backgrounds[rand(0, cfg.backgrounds.length-1)];
  const bgData = bgCache.get(bgUrl)!;

  const x0 = rand(cfg.positions.x.min, cfg.positions.x.max);
  const y0 = rand(cfg.positions.y.min, cfg.positions.y.max);
  const j = cfg.randomize.jitter;
  const x = x0 + (j ? rand(-j,j) : 0);
  const y = y0 + (j ? rand(-j,j) : 0);
  const theme: string = pick(cfg.randomize.theme);
  const hl: string = pick(cfg.randomize.languages);

  // 2) Открываем твой renderer (index.html на GH Pages/локально)
  const url = new URL(cfg.rendererUrl);
  url.searchParams.set('prov', t.prov);
  url.searchParams.set('size', t.pCfg.size || 'normal');
  url.searchParams.set('variant', t.pCfg.variant || 'checkbox');
  url.searchParams.set('theme', theme || 'light');
  url.searchParams.set('hl', hl || 'ru');
  url.searchParams.set('x', String(x));
  url.searchParams.set('y', String(y));
  if (!cfg.disableIframeBackground) url.searchParams.set('bgUrl', bgUrl); // можно включить, но мы обычно подставляем картинку

  await safeGoto(page, url.toString(), cfg.timeouts.pageLoadMs);

  // Подкладываем картинку фона (без сети)
  await page.evaluate((dataUri) => {
    const img = document.getElementById('bgImg') as HTMLImageElement | null;
    if (img) img.src = dataUri;
  }, bgData);

  // Ждём появление iframe виджета
  const waitSel =
    t.prov === 'hcaptcha'  ? 'iframe[src*="hcaptcha"]' :
    t.prov === 'turnstile' ? 'iframe[src*="challenges.cloudflare.com"]' :
                             'iframe[src*="api2/anchor"]'; // reCAPTCHA v2 anchor
  await page.waitForSelector(waitSel, { timeout: cfg.timeouts.providerIframeMs }).catch(()=>{});

  // Папка вывода: либо out/<prov>/<split>/, либо out/<prov>/
  const splitDir = chooseSplitDir(cfg.split);
  const baseOut = splitDir
    ? path.join(cfg.outDir, t.prov, splitDir)
    : path.join(cfg.outDir, t.prov);
  await ensureDir(baseOut);

  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  const stemBase = `${ts}_${String(globalIdx).padStart(6,'0')}`;

  let framesSaved = 0;

  // --- PRE (до клика)
  if (cfg.capture === 'pre' || cfg.capture === 'both') {
    const rect = await getWrapperBBox(page);
    const png = path.join(baseOut, `${stemBase}_pre.png`);
    const meta = path.join(baseOut, `${stemBase}_pre.json`);
    const yolo = path.join(baseOut, `${stemBase}_pre.txt`);
    await page.screenshot({ path: png, fullPage: cfg.fullPage });
    framesSaved++;
    if (cfg.yolo && rect) await yoloWrite(yolo, CLASS_ID[t.prov], rect, cfg.viewport.width, cfg.viewport.height);
    await fs.writeFile(meta, JSON.stringify({
      provider: t.prov, variant: t.pCfg.variant||null, size: t.pCfg.size||'normal',
      state: 'pre', theme, lang: hl, backgroundUrl: bgUrl,
      position: {x,y}, viewport: cfg.viewport, bbox: rect, createdAt: new Date().toISOString()
    }, null, 2));
  }

  // --- POST (после клика/попытки открыть челлендж)
  if (cfg.capture === 'post' || cfg.capture === 'both') {
    let opened = false;
    if (t.pCfg.openChallenge) {
      if (t.prov === 'hcaptcha') opened = await tryOpenHcaptcha(page, cfg.timeouts.afterClickDelayMs, cfg.timeouts.providerIframeMs);
      else if (t.prov === 'recaptcha') opened = await tryOpenRecaptchaV2(page, cfg.timeouts.afterClickDelayMs, cfg.timeouts.providerIframeMs);
      else if (t.prov === 'turnstile') {
        const ifr = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
        const bb = await ifr.boundingBox().catch(()=>null);
        if (bb) { await page.mouse.click(bb.x + bb.width/2, bb.y + bb.height/2); opened = true; }
        await page.waitForTimeout(cfg.timeouts.afterClickDelayMs);
      }
    }

    const rect = await getWrapperBBox(page);
    const png = path.join(baseOut, `${stemBase}_post.png`);
    const meta = path.join(baseOut, `${stemBase}_post.json`);
    const yolo = path.join(baseOut, `${stemBase}_post.txt`);
    const challengeRect = cfg.includeChallengeBBox ? await getChallengeBBox(page, t.prov) : null;

    await page.screenshot({ path: png, fullPage: cfg.fullPage });
    framesSaved++;
    if (cfg.yolo && rect) await yoloWrite(yolo, CLASS_ID[t.prov], rect, cfg.viewport.width, cfg.viewport.height);
    await fs.writeFile(meta, JSON.stringify({
      provider: t.prov, variant: t.pCfg.variant||null, size: t.pCfg.size||'normal',
      state: 'post', challengeOpened: opened, challengeBBox: challengeRect,
      theme, lang: hl, backgroundUrl: bgUrl,
      position: {x,y}, viewport: cfg.viewport, bbox: rect, createdAt: new Date().toISOString()
    }, null, 2));
  }

  return framesSaved; // нужно для прогресса
}

// ----------------------------
// MAIN
// ----------------------------
(async () => {
  const cfg = await readConfig();
  await ensureDir(cfg.outDir);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage'] // полезно в Docker/WSL
  });
  const ctx = await browser.newContext({ viewport: cfg.viewport });

  // 1) Кешируем фоновые картинки (ускоряет работу)
  const bgCache = await prepareBgCache(ctx, cfg);

  // 2) Формируем задачи (по числу count у провайдеров)
  const tasks = makeTasks(cfg.providers);

  // 3) Считаем общее кол-во кадров (для прогресс-бара)
  const framesPerTask = cfg.capture === 'both' ? 2 : 1;
  const totalFrames = tasks.length * framesPerTask;

  // 4) Прогресс-бар
  const bar = new cliProgress.SingleBar({
    format: `${pc.cyan('CAPTCHA')} ${pc.gray('|')} {bar} {percentage}% ${pc.gray('|')} {value}/{total} frames ${pc.gray('|')} ETA: {eta_formatted}`,
    barCompleteChar: pc.green('█'),
    barIncompleteChar: pc.dim('░'),
    hideCursor: true
  });
  bar.start(totalFrames, 0);

  // 5) Пул воркеров (страницы реюзятся, конкаренси регулируется в конфиге)
  let cursor = 0;
  let globalIdx = 0;

  async function worker(wid: number) {
    const page = await ctx.newPage();
    while (true) {
      const myIdx = cursor++;
      if (myIdx >= tasks.length) break;

      const t = tasks[myIdx];
      let attempt = 0;
      while (attempt <= cfg.retries) {
        try {
          const saved = await runOne(page, bgCache, cfg, t, globalIdx++);
          bar.increment(saved); // обновляем прогресс на кол-во реально сохранённых кадров
          break;
        } catch (e:any) {
          attempt++;
          if (attempt > cfg.retries) {
            console.error(pc.red(`[worker ${wid}] task failed:`), e?.message || e);
          } else {
            await page.waitForTimeout(300); // микро-пауза перед ретраем
          }
        }
      }
    }
    await page.close().catch(()=>{});
  }

  const workers = Array.from({length: cfg.concurrency}, (_,i)=>worker(i));
  await Promise.all(workers);

  bar.stop();
  await ctx.close();
  await browser.close();
  console.log(pc.green('All done.'));
})();
