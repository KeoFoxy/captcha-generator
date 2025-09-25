import { chromium, Page, BrowserContext } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';
import pc from 'picocolors';
import cliProgress from 'cli-progress';

// ========= Types =========
export type Prov = 'recaptcha' | 'hcaptcha' | 'turnstile';
export type Theme = 'light' | 'dark';
export type CaptureMode = 'pre' | 'post' | 'both';

export interface Viewport { width: number; height: number }
export interface XYRange { min: number; max: number }
export interface Positions { x: XYRange; y: XYRange }
export interface Timeouts { pageLoadMs: number; providerIframeMs: number; afterClickDelayMs: number }
export interface Randomize { theme: Theme[]; languages: string[]; jitter: number }
export interface ProviderCfg { name: Prov; count: number; size: string; variant?: string; openChallenge?: boolean }
export type Split = false | { train: number; val: number; test: number };

export interface Config {
  outDir: string;
  viewport: Viewport;
  backgrounds: string[];
  providers: ProviderCfg[];
  positions: Positions;
  randomize: Randomize;
  split: Split;
  yolo: boolean;
  includeChallengeBBox: boolean;
  capture: CaptureMode;
  fullPage: boolean;
  concurrency: number;
  disableIframeBackground: boolean;
  retries: number;
  timeouts: Timeouts;
  rendererUrl: string;
}

// Classes for YOLO labels (order is your choice)
const CLASS_ID: Record<Prov, number> = { recaptcha: 0, hcaptcha: 1, turnstile: 2 };

// ========= Args & config =========
function getArg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

function isProv(v: unknown): v is Prov {
  return v === 'recaptcha' || v === 'hcaptcha' || v === 'turnstile';
}

function applyDefaults(partial: Partial<Config>): Config {
  // Fill defaults safely; throw on missing required fields
  const viewport: Viewport = partial.viewport ?? { width: 1280, height: 800 };
  const positions: Positions = partial.positions ?? { x: { min: 24, max: Math.max(24, viewport.width - 300) }, y: { min: 96, max: Math.max(96, viewport.height - 200) } };
  const randomize: Randomize = partial.randomize ?? { theme: ['light', 'dark'], languages: ['en'], jitter: 0 };
  const timeouts: Timeouts = partial.timeouts ?? { pageLoadMs: 15000, providerIframeMs: 8000, afterClickDelayMs: 800 };

  const cfg: Config = {
    outDir: partial.outDir ?? 'out',
    viewport,
    backgrounds: Array.isArray(partial.backgrounds) ? partial.backgrounds : [],
    providers: Array.isArray(partial.providers) ? partial.providers as ProviderCfg[] : [],
    positions,
    randomize,
    split: (partial.split ?? false) as Split,
    yolo: Boolean(partial.yolo ?? false),
    includeChallengeBBox: Boolean(partial.includeChallengeBBox ?? true),
    capture: (partial.capture ?? 'both') as CaptureMode,
    fullPage: Boolean(partial.fullPage ?? false),
    concurrency: Number(partial.concurrency ?? 4),
    disableIframeBackground: Boolean(partial.disableIframeBackground ?? true),
    retries: Number(partial.retries ?? 1),
    timeouts,
    rendererUrl: String(partial.rendererUrl ?? 'https://keofoxy.github.io/captcha-generator/index.html')
  };

  // Minimal validation with readable errors
  if (!cfg.backgrounds.length) throw new Error('config.backgrounds must be a non-empty array');
  if (!cfg.providers.length) throw new Error('config.providers must be a non-empty array');
  for (const p of cfg.providers) {
    if (!isProv((p as ProviderCfg).name)) throw new Error(`providers[].name must be one of recaptcha|hcaptcha|turnstile`);
    if (!Number.isInteger(p.count) || p.count <= 0) throw new Error('providers[].count must be positive integer');
  }
  if (cfg.split && typeof cfg.split === 'object') {
    const s = cfg.split; const sum = s.train + s.val + s.test;
    if (Math.abs(sum - 1) > 1e-6) throw new Error('split train+val+test must sum to 1, or set split=false');
  }
  return cfg;
}

async function readConfig(): Promise<Config> {
  const configPath = getArg('--config', 'config.json')!;
  const raw = await fs.readFile(configPath, 'utf-8');
  const json = JSON.parse(raw) as Partial<Config>;
  return applyDefaults(json);
}

// ========= Small utils =========
function pick<T>(arr: readonly T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function rand(min: number, max: number) { return min + Math.floor(Math.random() * (max - min + 1)); }
async function ensureDir(d: string) { await fs.mkdir(d, { recursive: true }); }

async function safeGoto(page: Page, url: string, timeout: number) {
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout }); } catch { /* tolerate flaky loads */ }
}

async function screenshotDataUri(page: Page, url: string, vw: number, vh: number, timeout: number, fullPage: boolean) {
  await page.setViewportSize({ width: vw, height: vh });
  await safeGoto(page, url, timeout);
  const buf = await page.screenshot({ fullPage });
  return `data:image/png;base64,${buf.toString('base64')}`;
}

async function yoloWrite(labelPath: string, cls: number, rect: { x: number; y: number; width: number; height: number }, vw: number, vh: number) {
  const xC = (rect.x + rect.width / 2) / vw;
  const yC = (rect.y + rect.height / 2) / vh;
  const w = rect.width / vw; const h = rect.height / vh;
  await fs.writeFile(labelPath, `${cls} ${xC.toFixed(6)} ${yC.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}
`, 'utf-8');
}

// ========= Open challenge helpers =========
async function tryOpenHcaptcha(page: Page, afterClickDelayMs: number, providerIframeMs: number): Promise<boolean> {
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
    const opened = (await page.locator('iframe[src*="hcaptcha"][title*="challenge"], iframe[title*="hCaptcha challenge"]').count().catch(() => 0)) > 0;
    if (opened) return true;
  }
  return false;
}

async function tryOpenRecaptchaV2(page: Page, afterClickDelayMs: number, providerIframeMs: number): Promise<boolean> {
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

// ========= BBoxes =========
async function getWrapperBBox(page: Page): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.cap-wrapper') as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  });
}

async function getChallengeBBox(page: Page, prov: Prov): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const sel = prov === 'hcaptcha'
    ? 'iframe[src*="hcaptcha"][title*="challenge"], iframe[title*="hCaptcha challenge"]'
    : prov === 'recaptcha'
    ? 'iframe[src*="api2/bframe"]'
    : '';
  if (!sel) return null;
  const lf = page.locator(sel).first();
  const bb = await lf.boundingBox().catch(() => null);
  if (!bb) return null;
  return { x: Math.round(bb.x), y: Math.round(bb.y), width: Math.round(bb.width), height: Math.round(bb.height) };
}

// ========= Tasks =========
interface Task { prov: Prov; pCfg: ProviderCfg; idx: number }

function makeTasks(providers: ProviderCfg[]): Task[] {
  const tasks: Task[] = [];
  for (const p of providers) for (let i = 0; i < p.count; i++) tasks.push({ prov: p.name, pCfg: p, idx: i });
  for (let i = tasks.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [tasks[i], tasks[j]] = [tasks[j], tasks[i]]; }
  return tasks;
}

function chooseSplitDir(split: Split): 'train' | 'val' | 'test' | null {
  if (!split) return null;
  const r = Math.random();
  return r < split.train ? 'train' : (r < split.train + split.val ? 'val' : 'test');
}

async function prepareBgCache(ctx: BrowserContext, cfg: Config): Promise<Map<string, string>> {
  const page = await ctx.newPage();
  const cache = new Map<string, string>();
  for (const url of Array.from(new Set(cfg.backgrounds))) {
    try {
      const data = await screenshotDataUri(page, url, cfg.viewport.width, cfg.viewport.height, cfg.timeouts.pageLoadMs, cfg.fullPage);
      cache.set(url, data);
      process.stdout.write(pc.dim(`[bg cached] ${url}
`));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(pc.red('[bg fail]'), url, msg);
    }
  }
  await page.close().catch(() => {});
  return cache;
}

// ========= One task runner =========
async function runOne(page: Page, bgCache: Map<string, string>, cfg: Config, t: Task, globalIdx: number): Promise<number> {
  const bgUrl = cfg.backgrounds[rand(0, cfg.backgrounds.length - 1)];
  const bgData = bgCache.get(bgUrl)!;

  const x0 = rand(cfg.positions.x.min, cfg.positions.x.max);
  const y0 = rand(cfg.positions.y.min, cfg.positions.y.max);
  const j = cfg.randomize.jitter;
  const x = x0 + (j ? rand(-j, j) : 0);
  const y = y0 + (j ? rand(-j, j) : 0);
  const theme: Theme = pick(cfg.randomize.theme);
  const hl: string = pick(cfg.randomize.languages);

  const url = new URL(cfg.rendererUrl);
  url.searchParams.set('prov', t.prov);
  url.searchParams.set('size', t.pCfg.size || 'normal');
  url.searchParams.set('variant', t.pCfg.variant || 'checkbox');
  url.searchParams.set('theme', theme);
  url.searchParams.set('hl', hl);
  url.searchParams.set('x', String(x));
  url.searchParams.set('y', String(y));
  if (!cfg.disableIframeBackground) url.searchParams.set('bgUrl', bgUrl);

  await safeGoto(page, url.toString(), cfg.timeouts.pageLoadMs);

  await page.evaluate((dataUri: string) => {
    const img = document.getElementById('bgImg') as HTMLImageElement | null;
    if (img) img.src = dataUri;
  }, bgData);

  const waitSel = t.prov === 'hcaptcha' ? 'iframe[src*="hcaptcha"]' : t.prov === 'turnstile' ? 'iframe[src*="challenges.cloudflare.com"]' : 'iframe[src*="api2/anchor"]';
  await page.waitForSelector(waitSel, { timeout: cfg.timeouts.providerIframeMs }).catch(() => {});

  const splitDir = chooseSplitDir(cfg.split);
  const baseOut = splitDir ? path.join(cfg.outDir, t.prov, splitDir) : path.join(cfg.outDir, t.prov);
  await ensureDir(baseOut);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const stemBase = `${ts}_${String(globalIdx).padStart(6, '0')}`;
  let framesSaved = 0;

  if (cfg.capture === 'pre' || cfg.capture === 'both') {
    const rect = await getWrapperBBox(page);
    const png = path.join(baseOut, `${stemBase}_pre.png`);
    const meta = path.join(baseOut, `${stemBase}_pre.json`);
    const yolo = path.join(baseOut, `${stemBase}_pre.txt`);
    await page.screenshot({ path: png, fullPage: cfg.fullPage });
    framesSaved++;
    if (cfg.yolo && rect) await yoloWrite(yolo, CLASS_ID[t.prov], rect, cfg.viewport.width, cfg.viewport.height);
    await fs.writeFile(meta, JSON.stringify({
      provider: t.prov, variant: t.pCfg.variant ?? null, size: t.pCfg.size || 'normal',
      state: 'pre', theme, lang: hl, backgroundUrl: bgUrl,
      position: { x, y }, viewport: cfg.viewport, bbox: rect, createdAt: new Date().toISOString()
    }, null, 2));
  }

  if (cfg.capture === 'post' || cfg.capture === 'both') {
    let opened = false;
    if (t.pCfg.openChallenge) {
      if (t.prov === 'hcaptcha') opened = await tryOpenHcaptcha(page, cfg.timeouts.afterClickDelayMs, cfg.timeouts.providerIframeMs);
      else if (t.prov === 'recaptcha') opened = await tryOpenRecaptchaV2(page, cfg.timeouts.afterClickDelayMs, cfg.timeouts.providerIframeMs);
      else if (t.prov === 'turnstile') {
        const ifr = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
        const bb = await ifr.boundingBox().catch(() => null);
        if (bb) { await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); opened = true; }
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
      provider: t.prov, variant: t.pCfg.variant ?? null, size: t.pCfg.size || 'normal',
      state: 'post', challengeOpened: opened, challengeBBox: challengeRect,
      theme, lang: hl, backgroundUrl: bgUrl,
      position: { x, y }, viewport: cfg.viewport, bbox: rect, createdAt: new Date().toISOString()
    }, null, 2));
  }

  return framesSaved;
}

// ========= Main =========
(async () => {
  const cfg = await readConfig();
  await ensureDir(cfg.outDir);

  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: cfg.viewport });

  const bgCache = await prepareBgCache(ctx, cfg);
  const tasks = makeTasks(cfg.providers);

  const framesPerTask = cfg.capture === 'both' ? 2 : 1;
  const totalFrames = tasks.length * framesPerTask;

  const bar = new cliProgress.SingleBar({
    format: `${pc.cyan('CAPTCHA')} ${pc.gray('|')} {bar} {percentage}% ${pc.gray('|')} {value}/{total} frames ${pc.gray('|')} ETA: {eta_formatted}`,
    barCompleteChar: pc.green('█'),
    barIncompleteChar: pc.dim('░'),
    hideCursor: true
  });
  bar.start(totalFrames, 0);

  let cursor = 0; let globalIdx = 0;
  async function worker(wid: number): Promise<void> {
    const page = await ctx.newPage();
    while (true) {
      const myIdx = cursor++;
      if (myIdx >= tasks.length) break;
      const t = tasks[myIdx];
      let attempt = 0;
      while (attempt <= cfg.retries) {
        try {
          const saved = await runOne(page, bgCache, cfg, t, globalIdx++);
          bar.increment(saved);
          break;
        } catch (e) {
          attempt++;
          if (attempt > cfg.retries) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(pc.red(`[worker ${wid}] task failed:`), msg);
          } else {
            await page.waitForTimeout(300);
          }
        }
      }
    }
    await page.close().catch(() => {});
  }

  const workers = Array.from({ length: cfg.concurrency }, (_, i) => worker(i));
  await Promise.all(workers);

  bar.stop();
  await ctx.close();
  await browser.close();
  console.log(pc.green('All done.'));
})();