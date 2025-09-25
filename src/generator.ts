import { chromium, Page, BrowserContext } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';
import pc from 'picocolors';
import cliProgress from 'cli-progress';

// ========= Types =========

// Тип провайдера капчи — поддерживаем три
export type Prov = 'recaptcha' | 'hcaptcha' | 'turnstile';
// Тема оформления — сейчас две
export type Theme = 'light' | 'dark';
// Режим съёмки — до клика, после клика, или оба
export type CaptureMode = 'pre' | 'post' | 'both';

// Простые интерфейсы для структур конфига
export interface Viewport { width: number; height: number }
export interface XYRange { min: number; max: number }
export interface Positions { x: XYRange; y: XYRange }
export interface Timeouts { pageLoadMs: number; providerIframeMs: number; afterClickDelayMs: number }
export interface Randomize { theme: Theme[]; languages: string[]; jitter: number }
// Описание одного провайдера в конфиге
export interface ProviderCfg { name: Prov; count: number; size: string; variant?: string; openChallenge?: boolean }
// Разбиение на подпапки (или false, чтобы не разбивать)
export type Split = false | { train: number; val: number; test: number };

// Главный интерфейс конфига
export interface Config {
  outDir: string;                     // корневая папка вывода
  viewport: Viewport;                 // размер окна
  backgrounds: string[];              // список URL фонов
  providers: ProviderCfg[];           // список провайдеров и объём генерации
  positions: Positions;               // диапазоны координат капчи
  randomize: Randomize;               // тема/язык/джиттер
  split: Split;                       // разбивка на train/val/test, либо false
  yolo: boolean;                      // писать ли .txt с YOLO bbox контейнера
  includeChallengeBBox: boolean;      // включать ли bbox внутреннего челленджа в POST-мета
  capture: CaptureMode;               // какие кадры снимать на кейс
  fullPage: boolean;                  // делать ли скрин всей страницы
  concurrency: number;                // число параллельных «воркеров» (открытых страниц)
  disableIframeBackground: boolean;   // не грузить фон через iframe, использовать только картинку
  retries: number;                    // ретраи на один кейс
  timeouts: Timeouts;                 // таймауты
  rendererUrl: string;                // URL рендерера (ваш index.html)
}

// Сопоставление классов для YOLO: какой провайдер → какой id класса
const CLASS_ID: Record<Prov, number> = { recaptcha: 0, hcaptcha: 1, turnstile: 2 };

// ========= Args & config =========

// Берём значение аргумента CLI (например, --config path/to.json)
function getArg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

// Узнаём, что строка — допустимый провайдер
function isProv(v: unknown): v is Prov {
  return v === 'recaptcha' || v === 'hcaptcha' || v === 'turnstile';
}

// Подкладываем дефолты и валидируем минимально понятными ошибками
function applyDefaults(partial: Partial<Config>): Config {
  // Дефолтный вьюпорт, если не указан
  const viewport: Viewport = partial.viewport ?? { width: 1280, height: 800 };
  // Диапазоны координат — бОльшие по ширине/высоте, но со здравыми отступами
  const positions: Positions = partial.positions ?? {
    x: { min: 24, max: Math.max(24, viewport.width - 300) },
    y: { min: 96, max: Math.max(96, viewport.height - 200) }
  };
  // Рандомизация по умолчанию
  const randomize: Randomize = partial.randomize ?? { theme: ['light', 'dark'], languages: ['en'], jitter: 0 };
  // Таймауты по умолчанию
  const timeouts: Timeouts = partial.timeouts ?? { pageLoadMs: 15000, providerIframeMs: 8000, afterClickDelayMs: 800 };

  // Собираем конфиг целиком
  const cfg: Config = {
    outDir: partial.outDir ?? 'out',
    viewport,
    backgrounds: Array.isArray(partial.backgrounds) ? partial.backgrounds : [],
    providers: Array.isArray(partial.providers) ? (partial.providers as ProviderCfg[]) : [],
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

  // Минимальная валидация: обязательные поля
  if (!cfg.backgrounds.length) throw new Error('config.backgrounds must be a non-empty array');
  if (!cfg.providers.length) throw new Error('config.providers must be a non-empty array');

  // Проверяем каждый провайдер
  for (const p of cfg.providers) {
    if (!isProv(p.name)) throw new Error(`providers[].name must be one of recaptcha|hcaptcha|turnstile`);
    if (!Number.isInteger(p.count) || p.count <= 0) throw new Error('providers[].count must be positive integer');
  }

  // Если split включён — сумма вероятностей должна быть 1.0
  if (cfg.split && typeof cfg.split === 'object') {
    const s = cfg.split; const sum = s.train + s.val + s.test;
    if (Math.abs(sum - 1) > 1e-6) throw new Error('split train+val+test must sum to 1, or set split=false');
  }
  return cfg;
}

// Читаем JSON, применяем дефолты/валидацию
async function readConfig(): Promise<Config> {
  const configPath = getArg('--config', 'config.json')!; // путь к файлу конфига
  const raw = await fs.readFile(configPath, 'utf-8');    // читаем как строку
  const json = JSON.parse(raw) as Partial<Config>;       // парсим
  return applyDefaults(json);                            // приводим к полному Config
}

// ========= Small utils =========

// Выбираем случайный элемент
function pick<T>(arr: readonly T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
// Целый рандом в [min, max]
function rand(min: number, max: number) { return min + Math.floor(Math.random() * (max - min + 1)); }
// Создаём папку рекурсивно (если нет)
async function ensureDir(d: string) { await fs.mkdir(d, { recursive: true }); }

// Безопасная навигация: ждём DOMContentLoaded, но игнорируем флейки
async function safeGoto(page: Page, url: string, timeout: number) {
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout }); } catch { /* tolerate flaky loads */ }
}

// Делаем скриншот указанной страницы и возвращаем data:uri (для фона)
async function screenshotDataUri(page: Page, url: string, vw: number, vh: number, timeout: number, fullPage: boolean) {
  await page.setViewportSize({ width: vw, height: vh });   // выставляем вьюпорт
  await safeGoto(page, url, timeout);                      // переходим на URL
  const buf = await page.screenshot({ fullPage });         // делаем скрин
  return `data:image/png;base64,${buf.toString('base64')}`;// переводим в data:uri
}

// Пишем YOLO-разметку: class_id cx cy w h (всё нормализовано в [0..1])
async function yoloWrite(
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

// ========= Open challenge helpers =========

// Пробуем «раскрыть» hCaptcha: кликаем по вероятным точкам, ждём появления challenge-iframe
async function tryOpenHcaptcha(page: Page, afterClickDelayMs: number, providerIframeMs: number): Promise<boolean> {
  const sel = 'iframe[src*="hcaptcha"]';                                    // селектор виджета
  await page.waitForSelector(sel, { timeout: providerIframeMs }).catch(() => {});
  const ifr = page.locator(sel).first();                                    // первый iframe
  const bb = await ifr.boundingBox().catch(() => null);                     // ищем bbox
  if (!bb) return false;

  // Пробуем разные точки в рамке виджета (чекбокс часто слева-сверху)
  const pts = [
    { x: bb.x + 18, y: bb.y + 18 },
    { x: bb.x + Math.min(28, bb.width / 4), y: bb.y + bb.height / 2 },
    { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }
  ];
  for (const p of pts) {
    await page.mouse.click(p.x, p.y);                                       // клик
    await page.waitForTimeout(afterClickDelayMs);                           // ждём UI
    // Проверяем, открылся ли challenge-iframe
    const opened = (await page
      .locator('iframe[src*="hcaptcha"][title*="challenge"], iframe[title*="hCaptcha challenge"]')
      .count()
      .catch(() => 0)) > 0;
    if (opened) return true;
  }
  return false;
}

// Аналогично для reCAPTCHA v2 checkbox: сначала якорный iframe api2/anchor, затем ищем api2/bframe
async function tryOpenRecaptchaV2(page: Page, afterClickDelayMs: number, providerIframeMs: number): Promise<boolean> {
  const anchorSel = 'iframe[src*="api2/anchor"]';                           // виджет-чекбокс
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
    await page.mouse.click(p.x, p.y);                                       // клик
    await page.waitForTimeout(afterClickDelayMs);                           // ждём UI
    // Появление api2/bframe означает окно с картинками
    const challenge = await page.locator('iframe[src*="api2/bframe"]').count().catch(() => 0);
    if (challenge > 0) return true;
  }
  return false;
}

// ========= BBoxes =========

// Берём bbox внешней обёртки .cap-wrapper (именно её мы позиционируем)
async function getWrapperBBox(page: Page): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate(() => {
    const el = document.querySelector('.cap-wrapper') as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  });
}

// Берём bbox внутреннего «челленджа» (если он есть) — отдельный iframe
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

// Внутреннее представление задачи: один «кейс» конкретного провайдера
interface Task { prov: Prov; pCfg: ProviderCfg; idx: number }

// Генерируем очередь задач по counts и немного перемешиваем
function makeTasks(providers: ProviderCfg[]): Task[] {
  const tasks: Task[] = [];
  for (const p of providers) {
    for (let i = 0; i < p.count; i++) tasks.push({ prov: p.name, pCfg: p, idx: i });
  }
  // Фишер-Йетс перемешивание
  for (let i = tasks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tasks[i], tasks[j]] = [tasks[j], tasks[i]];
  }
  return tasks;
}

// Выбираем подпапку согласно вероятностям split, либо null (если split=false)
function chooseSplitDir(split: Split): 'train' | 'val' | 'test' | null {
  if (!split) return null;
  const r = Math.random();
  return r < split.train ? 'train' : (r < split.train + split.val ? 'val' : 'test');
}

// Предварительно снимаем скрины всех backgrounds и кладём в кэш (Map url -> data:uri)
async function prepareBgCache(ctx: BrowserContext, cfg: Config): Promise<Map<string, string>> {
  const page = await ctx.newPage();
  const cache = new Map<string, string>();
  for (const url of Array.from(new Set(cfg.backgrounds))) {
    try {
      const data = await screenshotDataUri(page, url, cfg.viewport.width, cfg.viewport.height, cfg.timeouts.pageLoadMs, cfg.fullPage);
      cache.set(url, data);
      process.stdout.write(pc.dim(`[bg cached] ${url}\n`));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(pc.red('[bg fail]'), url, msg);
    }
  }
  await page.close().catch(() => {});
  return cache;
}

// ========= One task runner =========

// Выполняем один кейс: грузим рендерер, подставляем фон, ждём виджет, делаем PRE/POST
async function runOne(
  page: Page,
  bgCache: Map<string, string>,
  cfg: Config,
  t: Task,
  globalIdx: number
): Promise<number> {
  // Случайный фон и его картинка из кэша
  const bgUrl = cfg.backgrounds[rand(0, cfg.backgrounds.length - 1)];
  const bgData = bgCache.get(bgUrl)!; // воскл. — предполагаем, что кэш подготовлен

  // Случайное положение и небольшая «дрожь»
  const x0 = rand(cfg.positions.x.min, cfg.positions.x.max);
  const y0 = rand(cfg.positions.y.min, cfg.positions.y.max);
  const j = cfg.randomize.jitter;
  const x = x0 + (j ? rand(-j, j) : 0);
  const y = y0 + (j ? rand(-j, j) : 0);

  // Случайные тема/язык из списков
  const theme: Theme = pick(cfg.randomize.theme);
  const hl: string = pick(cfg.randomize.languages);

  // Собираем URL к рендереру c query-параметрами
  const url = new URL(cfg.rendererUrl);
  url.searchParams.set('prov', t.prov);
  url.searchParams.set('size', t.pCfg.size || 'normal');
  url.searchParams.set('variant', t.pCfg.variant || 'checkbox');
  url.searchParams.set('theme', theme);
  url.searchParams.set('hl', hl);
  url.searchParams.set('x', String(x));
  url.searchParams.set('y', String(y));
  if (!cfg.disableIframeBackground) url.searchParams.set('bgUrl', bgUrl); // при желании: фон через <iframe>

  // Переходим на рендерер, ждём DOM
  await safeGoto(page, url.toString(), cfg.timeouts.pageLoadMs);

  // Подкладываем заранее снятую картинку фона (без сети и CSP)
  await page.evaluate((dataUri: string) => {
    const img = document.getElementById('bgImg') as HTMLImageElement | null;
    if (img) img.src = dataUri;
  }, bgData);

  // Ждём появления iframe конкретного провайдера (виджет «на месте»)
  const waitSel =
    t.prov === 'hcaptcha'
      ? 'iframe[src*="hcaptcha"]'
      : t.prov === 'turnstile'
      ? 'iframe[src*="challenges.cloudflare.com"]'
      : 'iframe[src*="api2/anchor"]'; // reCAPTCHA v2 anchor
  await page.waitForSelector(waitSel, { timeout: cfg.timeouts.providerIframeMs }).catch(() => {});

  // Подготовка папки вывода (с учётом split)
  const splitDir = chooseSplitDir(cfg.split);
  const baseOut = splitDir ? path.join(cfg.outDir, t.prov, splitDir) : path.join(cfg.outDir, t.prov);
  await ensureDir(baseOut);

  // Базовое имя файлов: timestamp + глобальный индекс
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const stemBase = `${ts}_${String(globalIdx).padStart(6, '0')}`;

  // Сколько кадров реально сохранили (для прогресс-бара)
  let framesSaved = 0;

  // --- PRE (до клика)
  if (cfg.capture === 'pre' || cfg.capture === 'both') {
    const rect = await getWrapperBBox(page);                             // bbox контейнера
    const png = path.join(baseOut, `${stemBase}_pre.png`);               // куда класть картинку
    const meta = path.join(baseOut, `${stemBase}_pre.json`);             // куда класть мета
    const yolo = path.join(baseOut, `${stemBase}_pre.txt`);              // куда класть yolo (если нужно)

    await page.screenshot({ path: png, fullPage: cfg.fullPage });        // скрин (быстро, если fullPage=false)
    framesSaved++;
    if (cfg.yolo && rect) await yoloWrite(yolo, CLASS_ID[t.prov], rect, cfg.viewport.width, cfg.viewport.height);

    // Пишем JSON-мета с координатами, позицией, темой/языком и т.п.
    await fs.writeFile(meta, JSON.stringify({
      provider: t.prov,
      variant: t.pCfg.variant ?? null,
      size: t.pCfg.size || 'normal',
      state: 'pre',
      theme,
      lang: hl,
      backgroundUrl: bgUrl,
      position: { x, y },
      viewport: cfg.viewport,
      bbox: rect,
      createdAt: new Date().toISOString()
    }, null, 2));
  }

  // --- POST (после клика / попытки открыть challenge)
  if (cfg.capture === 'post' || cfg.capture === 'both') {
    let opened = false;

    // Если включён openChallenge — пытаемся кликнуть так, чтобы появилось окно челленджа
    if (t.pCfg.openChallenge) {
      if (t.prov === 'hcaptcha') {
        opened = await tryOpenHcaptcha(page, cfg.timeouts.afterClickDelayMs, cfg.timeouts.providerIframeMs);
      } else if (t.prov === 'recaptcha') {
        opened = await tryOpenRecaptchaV2(page, cfg.timeouts.afterClickDelayMs, cfg.timeouts.providerIframeMs);
      } else if (t.prov === 'turnstile') {
        // У Turnstile отдельный челлендж-оверлей встречается реже; кликаем по центру iframe для консистентности
        const ifr = page.locator('iframe[src*="challenges.cloudflare.com"]').first();
        const bb = await ifr.boundingBox().catch(() => null);
        if (bb) { await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); opened = true; }
        await page.waitForTimeout(cfg.timeouts.afterClickDelayMs);
      }
    }

    const rect = await getWrapperBBox(page);                             // bbox внешней обёртки (может чуть измениться)
    const png = path.join(baseOut, `${stemBase}_post.png`);
    const meta = path.join(baseOut, `${stemBase}_post.json`);
    const yolo = path.join(baseOut, `${stemBase}_post.txt`);
    const challengeRect = cfg.includeChallengeBBox ? await getChallengeBBox(page, t.prov) : null;

    await page.screenshot({ path: png, fullPage: cfg.fullPage });
    framesSaved++;
    if (cfg.yolo && rect) await yoloWrite(yolo, CLASS_ID[t.prov], rect, cfg.viewport.width, cfg.viewport.height);

    await fs.writeFile(meta, JSON.stringify({
      provider: t.prov,
      variant: t.pCfg.variant ?? null,
      size: t.pCfg.size || 'normal',
      state: 'post',
      challengeOpened: opened,        // получилось ли открыть дочерний фрейм
      challengeBBox: challengeRect,   // и его bbox, если нашёлся
      theme,
      lang: hl,
      backgroundUrl: bgUrl,
      position: { x, y },
      viewport: cfg.viewport,
      bbox: rect,
      createdAt: new Date().toISOString()
    }, null, 2));
  }

  // Возвращаем, сколько кадров сохранили (для прогресс-бара)
  return framesSaved;
}

// ========= Main =========

// Главная точка входа
(async () => {
  const cfg = await readConfig();                     // читаем и валидируем конфиг
  await ensureDir(cfg.outDir);                        // создаём корневую папку вывода

  // Стартуем браузер Chromium в headless-режиме
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage']                // полезно для Docker/WSL
  });
  const ctx = await browser.newContext({ viewport: cfg.viewport }); // один контекст — много вкладок-воркеров

  // 1) Кешируем фоны (быстро: 1 вкладка гоняет по фонам, делает скрины в data:uri)
  const bgCache = await prepareBgCache(ctx, cfg);

  // 2) Формируем очередь задач по counts и перемешиваем
  const tasks = makeTasks(cfg.providers);

  // 3) Считаем, сколько кадров всего будет (для прогресс-бара)
  const framesPerTask = cfg.capture === 'both' ? 2 : 1;
  const totalFrames = tasks.length * framesPerTask;

  // 4) Настраиваем прогресс-бар
  const bar = new cliProgress.SingleBar({
    format: `${pc.cyan('CAPTCHA')} ${pc.gray('|')} {bar} {percentage}% ${pc.gray('|')} {value}/{total} frames ${pc.gray('|')} ETA: {eta_formatted}`,
    barCompleteChar: pc.green('█'),
    barIncompleteChar: pc.dim('░'),
    hideCursor: true
  });
  bar.start(totalFrames, 0);

  // 5) Запускаем пул воркеров — каждая «страница» переиспользуется для многих задач
  let cursor = 0;           // индекс текущей задачи в массиве
  let globalIdx = 0;        // глобальный счётчик кейсов для имён файлов

  // Один воркер: забирает задачи, делает runOne, обрабатывает ретраи
  async function worker(wid: number): Promise<void> {
    const page = await ctx.newPage();                // отдельная вкладка
    while (true) {
      const myIdx = cursor++;                        // берём следующий индекс
      if (myIdx >= tasks.length) break;              // задач больше нет
      const t = tasks[myIdx];                        // берём задачу
      let attempt = 0;                               // счётчик ретраев
      while (attempt <= cfg.retries) {
        try {
          const saved = await runOne(page, bgCache, cfg, t, globalIdx++); // выполняем кейс
          bar.increment(saved);                      // обновляем прогресс на кол-во реально сохранённых кадров
          break;                                     // успех — выходим из цикла ретраев
        } catch (e) {
          attempt++;
          if (attempt > cfg.retries) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(pc.red(`[worker ${wid}] task failed:`), msg);
          } else {
            await page.waitForTimeout(300);          // микропаузa перед повтором
          }
        }
      }
    }
    await page.close().catch(() => {});              // чистим вкладку
  }

  // Создаём и ждём завершения пула воркеров
  const workers = Array.from({ length: cfg.concurrency }, (_, i) => worker(i));
  await Promise.all(workers);

  // Завершаем прогресс, закрываем всё
  bar.stop();
  await ctx.close();
  await browser.close();
  console.log(pc.green('All done.'));
})();
