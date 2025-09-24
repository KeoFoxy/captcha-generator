// import { chromium, Page } from 'playwright';
// import { promises as fs } from 'fs';
// import path from 'path';
// import { randomInt } from 'crypto';
// import { z } from 'zod';

// const ProviderSchema = z.enum(['recaptcha', 'hcaptcha', 'turnstile']);
// const SizeSchema = z.enum(['normal', 'compact', 'auto']);

// const ConfigSchema = z.object({
//   outDir: z.string().default('out'),
//   viewport: z.object({ width: z.number(), height: z.number() }).default({ width: 1280, height: 800 }),
//   seed: z.number().optional(),
//   backgrounds: z.array(z.string()).min(1),
//   providers: z.array(z.object({
//     name: ProviderSchema,
//     count: z.number().int().positive(),
//     size: SizeSchema.default('normal')
//   })),
//   positions: z.object({
//     x: z.object({ min: z.number(), max: z.number() }),
//     y: z.object({ min: z.number(), max: z.number() })
//   })
// });

// type ProviderName = z.infer<typeof ProviderSchema>;

// type Config = z.infer<typeof ConfigSchema>;

// function parseArgs() {
//   const idx = process.argv.indexOf('--config');
//   const fp = idx > -1 ? process.argv[idx + 1] : 'config.json';
//   return fp;
// }

// function seededRand(min: number, max: number) {
//   return min + Math.floor(Math.random() * (max - min + 1));
// }

// function providerHtml(provider: ProviderName, size: 'normal' | 'compact' | 'auto') {
//   switch (provider) {
//     case 'recaptcha':
//       // Official v2 test keys (always No CAPTCHA / pass) — for UI rendering only
//       return `\n<script src="https://www.google.com/recaptcha/api.js" async defer></script>\n<div class="g-recaptcha" data-theme="light" data-size="${size === 'compact' ? 'compact' : 'normal'}" data-sitekey="6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI"></div>`;
//     case 'hcaptcha':
//       // Commonly used hCaptcha test keys for local/dev — do not use in production
//       return `\n<script src="https://js.hcaptcha.com/1/api.js" async defer></script>\n<div class="h-captcha" data-theme="light" data-size="${size === 'compact' ? 'compact' : 'normal'}" data-sitekey="10000000-ffff-ffff-ffff-000000000001"></div>`;
//     case 'turnstile':
//       // Cloudflare Turnstile testing keys. 3x...FF forces an interactive challenge
//       const tk = size === 'compact' ? '1x00000000000000000000BB' : '3x00000000000000000000FF';
//       return `\n<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>\n<div class="cf-turnstile" data-sitekey="${tk}" data-theme="light"></div>`;
//   }
// }

// function makeHtml(bgSrc: string, overlayHtml: string, x: number, y: number, vw: number, vh: number) {
//   return `<!doctype html>
// <html lang="en">
// <head>
//   <meta charset="utf-8" />
//   <meta name="viewport" content="width=device-width, initial-scale=1" />
//   <style>
//     html, body { margin:0; padding:0; width:${vw}px; height:${vh}px; overflow:hidden; }
//     .bg-frame { position:absolute; inset:0; border:0; width:100%; height:100%; }
//     .overlay { position:absolute; left:${x}px; top:${y}px; z-index:9999; }
//     .cap-wrapper { background:rgba(255,255,255,0.9); padding:8px; border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,0.2); }
//   </style>
// </head>
// <body>
//   <iframe class="bg-frame" src="${bgSrc}"></iframe>
//   <div class="overlay">
//     <div class="cap-wrapper">${overlayHtml}</div>
//   </div>
// </body>
// </html>`;
// }

// async function ensureDir(dir: string) {
//   await fs.mkdir(dir, { recursive: true });
// }

// async function main() {
//   const configPath = parseArgs();
//   const raw = await fs.readFile(configPath, 'utf-8');
//   const cfg = ConfigSchema.parse(JSON.parse(raw));

//   await ensureDir(cfg.outDir);

//   const browser = await chromium.launch({ headless: true });
//   const context = await browser.newContext({ viewport: cfg.viewport });
//   const page = await context.newPage();

//   let imgIndex = 0;

//   for (const p of cfg.providers) {
//     const baseOut = path.join(cfg.outDir, p.name);
//     await ensureDir(baseOut);

//     for (let i = 0; i < p.count; i++) {
//       const bg = cfg.backgrounds[seededRand(0, cfg.backgrounds.length - 1)];
//       const x = seededRand(cfg.positions.x.min, cfg.positions.x.max);
//       const y = seededRand(cfg.positions.y.min, cfg.positions.y.max);

//       const overlay = providerHtml(p.name, p.size as any);
//       const html = makeHtml(bg, overlay, x, y, cfg.viewport.width, cfg.viewport.height);

//       await page.setContent(html, { waitUntil: 'load' });

//       // Wait for provider widget container / iframe to load (best‑effort)
//       const sel = p.name === 'recaptcha' ? 'iframe[src*="recaptcha"]'
//                 : p.name === 'hcaptcha' ? 'iframe[src*="hcaptcha"]'
//                 : 'iframe[src*="challenges.cloudflare.com"]';
//       try { await page.waitForSelector(sel, { timeout: 7000 }); } catch {}

//       const ts = new Date().toISOString().replace(/[:.]/g, '-');
//       const fileStem = `${ts}_${String(imgIndex).padStart(5,'0')}`;
//       const pngPath = path.join(baseOut, `${fileStem}.png`);
//       const metaPath = path.join(baseOut, `${fileStem}.json`);

//       await page.screenshot({ path: pngPath, fullPage: true });

//       const metadata = {
//         provider: p.name,
//         size: p.size,
//         background: bg,
//         position: { x, y },
//         viewport: cfg.viewport,
//         index: imgIndex,
//         createdAt: new Date().toISOString()
//       };
//       await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2));

//       imgIndex++;
//       process.stdout.write(`Generated: ${pngPath}\n`);
//     }
//   }

//   await browser.close();
//   console.log('Done.');
// }

// main().catch(err => {
//   console.error(err);
//   process.exit(1);
// });
import { chromium } from 'playwright';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { promises as fs } from 'fs';
import path from 'path';

// ---------- Конфиг (просто отредактируй ниже, отдельный JSON не обязателен) ----------
const CONFIG = {
  outDir: 'out',
  viewport: { width: 1280, height: 800 },
  // Фоны: локальные HTML через file:// или картинки через img:// (скриншоты разрешённых страниц)
  backgrounds: [
    // пример локального HTML
    // 'file:///ABS_PATH/backgrounds/login.html',
    // пример картинки
    // 'img:///ABS_PATH/backgrounds-shots/site-001.png',
    'https://www.wikipedia.org', // если сайт разрешает в iframe — ок; если нет, используй img:// скрин
  ],
  // Сколько кадров генерить на каждого провайдера
  providers: [
    { name: 'recaptcha', count: 10, size: 'normal', variant: 'checkbox' },       // v2 checkbox
    { name: 'hcaptcha',  count: 10, size: 'normal', variant: 'checkbox' },       // checkbox (часто даёт image challenge после клика)
    { name: 'turnstile', count: 10, size: 'auto',   variant: 'interactive' },    // интерактивный режим
  ] as Array<{
    name: 'recaptcha'|'hcaptcha'|'turnstile';
    count: number;
    size: 'normal'|'compact'|'auto';
    variant?: 'checkbox'|'invisible'|'interactive'|'managed';
  }>,

  positions: { x: { min: 24, max: 980 }, y: { min: 96, max: 640 } },
  split: { train: 0.8, val: 0.1, test: 0.1 },
  annotation: { format: 'yolo' as 'yolo'|'none' },
  randomize: {
    theme: ['light','dark'] as Array<'light'|'dark'>,
    languages: ['en','ru','es'],
    jitter: 6, // px случайной дрожи вокруг позиции
  }
};
// -------------------------------------------------------------------------------------

type ProviderName = 'recaptcha'|'hcaptcha'|'turnstile';

// Классы для YOLO
const CLASS_ID: Record<ProviderName, number> = { recaptcha: 0, hcaptcha: 1, turnstile: 2 };

function seededRand(min: number, max: number) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function isImgBackground(src: string) { return src.startsWith('img://'); }
function imgSrcPath(src: string) { return src.replace('img://', ''); }

function providerHtml(
  provider: ProviderName,
  size: 'normal'|'compact'|'auto',
  variant: string|undefined,
  theme: 'light'|'dark',
  hl: string
) {
  if (provider === 'recaptcha') {
    // Google reCAPTCHA v2 test key — корректно работает на http(s) origin
    const sz = size === 'compact' ? 'compact' : 'normal';
    return `
<script src="https://www.google.com/recaptcha/api.js?hl=${hl}" async defer></script>
<div class="g-recaptcha" data-theme="${theme}" data-size="${sz}" data-sitekey="6LeIxAcTAAAAAJcZVRqyHh71UMIEGNQ_MXjiZKhI"></div>`;
  }

  if (provider === 'hcaptcha') {
    // hCaptcha test key — нужен http(s) origin
    const sz = size === 'compact' ? 'compact' : 'normal';
    return `
<script src="https://js.hcaptcha.com/1/api.js?hl=${hl}" async defer></script>
<div class="h-captcha" data-theme="${theme}" data-size="${sz}" data-sitekey="10000000-ffff-ffff-ffff-000000000001"></div>`;
  }

  // Cloudflare Turnstile: тестовые ключи. 3x...FF — форсит интерактивный челлендж.
  const tk = variant === 'interactive'
    ? '3x00000000000000000000FF'
    : (size === 'compact' ? '1x00000000000000000000BB' : '1x00000000000000000000AA'); // non-interactive/compact
  return `
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?hl=${hl}" async defer></script>
<div class="cf-turnstile" data-sitekey="${tk}" data-theme="${theme}"></div>`;
}

function makeHtml(
  baseBg: string,
  overlayHtml: string,
  x: number,
  y: number,
  vw: number,
  vh: number,
  theme: 'light'|'dark'
) {
  const bgTag = isImgBackground(baseBg)
    ? `<img src="${imgSrcPath(baseBg)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border:0"/>`
    : `<iframe class="bg-frame" src="${baseBg}"></iframe>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    html, body { margin:0; padding:0; width:${vw}px; height:${vh}px; overflow:hidden; background:${theme==='dark'?'#0b0b0b':'#fff'}; }
    .bg-frame { position:absolute; inset:0; border:0; width:100%; height:100%; }
    .overlay { position:absolute; left:${x}px; top:${y}px; z-index:9999; }
    .cap-wrapper { background:${theme==='dark'?'rgba(30,30,30,0.9)':'rgba(255,255,255,0.9)'}; padding:8px; border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,0.2); }
  </style>
</head>
<body>
  ${bgTag}
  <div class="overlay">
    <div class="cap-wrapper">${overlayHtml}</div>
  </div>
</body>
</html>`;
}

// Мини-сервер, чтобы страница имела http-origin (не about:blank)
async function startLocalServer(): Promise<{port:number, close:()=>Promise<void>}> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    // Пустая страница — дальше мы её перезапишем document.write(html)
    res.end('<!doctype html><html><head><meta charset="utf-8"/></head><body></body></html>');
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 31337);
    });
  });

  return {
    port,
    close: () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  };
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function yoloWrite(labelPath: string, cls: number, rect: {x:number;y:number;width:number;height:number}, vw:number, vh:number) {
  const xC = (rect.x + rect.width/2) / vw;
  const yC = (rect.y + rect.height/2) / vh;
  const w = rect.width / vw; const h = rect.height / vh;
  const line = `${cls} ${xC.toFixed(6)} ${yC.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}\n`;
  await fs.writeFile(labelPath, line, 'utf-8');
}

(async () => {
  await ensureDir(CONFIG.outDir);

  const { port, close } = await startLocalServer();
  const baseURL = `http://127.0.0.1:${port}/blank`;

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: CONFIG.viewport });
  const page = await ctx.newPage();

  let imgIndex = 0;

  for (const prov of CONFIG.providers) {
    const baseOut = path.join(CONFIG.outDir, prov.name);
    await ensureDir(baseOut);

    for (let i = 0; i < prov.count; i++) {
      const bg = CONFIG.backgrounds[seededRand(0, CONFIG.backgrounds.length - 1)];

      // позиция + лёгкий jitter
      const j = CONFIG.randomize?.jitter ?? 0;
      const x0 = seededRand(CONFIG.positions.x.min, CONFIG.positions.x.max);
      const y0 = seededRand(CONFIG.positions.y.min, CONFIG.positions.y.max);
      const x = x0 + (j ? seededRand(-j, j) : 0);
      const y = y0 + (j ? seededRand(-j, j) : 0);

      const theme = CONFIG.randomize?.theme ? pick(CONFIG.randomize.theme) : 'light';
      const hl = CONFIG.randomize?.languages ? pick(CONFIG.randomize.languages) : 'en';

      const overlay = providerHtml(prov.name, prov.size as any, prov.variant, theme, hl);
      const html = makeHtml(bg, overlay, x, y, CONFIG.viewport.width, CONFIG.viewport.height, theme);

      // ВАЖНО: сначала зайти на http-origin...
      await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
      // ...затем перезаписать DOM — origin сохранится (127.0.0.1)
      await page.evaluate((markup) => {
        document.open();
        document.write(markup);
        document.close();
      }, html);

      // дождаться появления iframe провайдера
      const sel =
        prov.name === 'recaptcha' ? 'iframe[src*="recaptcha"]' :
        prov.name === 'hcaptcha'  ? 'iframe[src*="hcaptcha"]'  :
                                    'iframe[src*="challenges.cloudflare.com"]';

      try { await page.waitForSelector(sel, { timeout: 12000 }); } catch {}

      // bbox по оболочке
      const rect = await page.evaluate(() => {
        const el = document.querySelector('.cap-wrapper') as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      });

      // разбиение train/val/test
      const r = Math.random();
      const splitDir = r < CONFIG.split.train ? 'train' : (r < CONFIG.split.train + CONFIG.split.val ? 'val' : 'test');
      const dir = path.join(baseOut, splitDir);
      await ensureDir(dir);

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const fileStem = `${ts}_${String(imgIndex).padStart(5,'0')}`;
      const pngPath = path.join(dir, `${fileStem}.png`);
      const metaPath = path.join(dir, `${fileStem}.json`);
      const labelPath = path.join(dir, `${fileStem}.txt`);

      await page.screenshot({ path: pngPath, fullPage: true });

      if (CONFIG.annotation.format === 'yolo' && rect) {
        await yoloWrite(labelPath, CLASS_ID[prov.name], rect, CONFIG.viewport.width, CONFIG.viewport.height);
      }

      const metadata = {
        provider: prov.name,
        variant: prov.variant ?? null,
        size: prov.size,
        theme,
        lang: hl,
        background: bg,
        position: { x, y },
        viewport: CONFIG.viewport,
        bbox: rect,
        index: imgIndex,
        createdAt: new Date().toISOString(),
        origin: baseURL
      };
      await fs.writeFile(metaPath, JSON.stringify(metadata, null, 2));

      imgIndex++;
      process.stdout.write(`Generated: ${pngPath}\n`);
    }
  }

  await browser.close();
  await close();
  console.log('Done.');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
