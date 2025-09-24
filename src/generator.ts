import { chromium } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';

const RENDER_URL_BASE = 'https://keofoxy.github.io/captcha-generator/'; // <-- на файл

const CONFIG = {
  outDir: 'out',
  viewport: { width: 1280, height: 800 },
  // URL-ы страниц, которые ты хочешь видеть в iframe (если нельзя встраивать — будет фолбэк-картинка)
  backgrounds: [
    'https://www.wikipedia.org/',
    'https://developer.mozilla.org/',
    // добавляй любые страницы, КОТОРЫЕ МОЖНО по правилам снимать и/или встраивать
  ],
  providers: [
    // hCaptcha: openChallenge=true — ткнуть по чекбоксу, чаще открывается сетка картинок
    { name: 'hcaptcha' as const,  count: 20, size: 'normal', variant: 'checkbox', openChallenge: true },
    // Turnstile интерактивный
    { name: 'turnstile' as const, count: 20, size: 'auto',   variant: 'interactive', openChallenge: false },
    // (опц.) reCAPTCHA v2 checkbox — если сделаешь прод-ключ на домен
    { name: 'recaptcha' as const, count: 10, size: 'normal', variant: 'checkbox', openChallenge: true },
    // (опц.) произвольный провайдер через сниппет:
    { name: 'snippet'  as const,  count: 10, size: 'normal', variant: 'geetest', openChallenge: true },
  ],
  positions: { x: { min: 24, max: 980 }, y: { min: 96, max: 640 } },
  randomize: { theme: ['light','dark'] as const, languages: ['en','ru','es'], jitter: 6 },
  split: { train: 0.8, val: 0.1, test: 0.1 },
  yolo: true
};

type Prov = 'recaptcha'|'hcaptcha'|'turnstile'|'snippet';
const CLASS_ID: Record<Prov, number> = { recaptcha:0, hcaptcha:1, turnstile:2, snippet:3 };

function pick<T>(arr: readonly T[]): T { return arr[Math.floor(Math.random()*arr.length)]; }
function rand(min:number,max:number){ return min + Math.floor(Math.random()*(max-min+1)); }
async function ensureDir(d:string){ await fs.mkdir(d,{recursive:true}); }

async function pageScreenshotDataUri(page, url: string, vw: number, vh: number) {
  await page.setViewportSize({ width: vw, height: vh });
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  } catch {}
  const buf = await page.screenshot({ fullPage: true });
  return `data:image/png;base64,${buf.toString('base64')}`;
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
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: CONFIG.viewport });
  const page = await ctx.newPage();

  // в отдельной вкладке снимем скрины фонов (кэшируем по url)
  const bgPage = await ctx.newPage();
  const bgDataCache = new Map<string,string>();

  let idx = 0;

  for (const p of CONFIG.providers) {
    const baseOut = path.join(CONFIG.outDir, p.name);
    await ensureDir(baseOut);

    for (let i=0;i<p.count;i++){
      const bgUrl = CONFIG.backgrounds[rand(0, CONFIG.backgrounds.length-1)];

      // подготовим фолбэк-картинку для этого URL (1 раз на url)
      if (!bgDataCache.has(bgUrl)) {
        const data = await pageScreenshotDataUri(bgPage, bgUrl, CONFIG.viewport.width, CONFIG.viewport.height);
        bgDataCache.set(bgUrl, data);
      }
      const bgData = bgDataCache.get(bgUrl)!;

      const x0 = rand(CONFIG.positions.x.min, CONFIG.positions.x.max);
      const y0 = rand(CONFIG.positions.y.min, CONFIG.positions.y.max);
      const j = CONFIG.randomize.jitter;
      const x = x0 + (j ? rand(-j,j) : 0);
      const y = y0 + (j ? rand(-j,j) : 0);
      const theme = pick(CONFIG.randomize.theme);
      const hl = pick(CONFIG.randomize.languages);

      const url = new URL(RENDER_URL_BASE);
      url.searchParams.set('prov', p.name as any);
      url.searchParams.set('size', p.size as any);
      url.searchParams.set('variant', (p as any).variant || 'checkbox');
      url.searchParams.set('theme', theme);
      url.searchParams.set('hl', hl);
      url.searchParams.set('x', String(x));
      url.searchParams.set('y', String(y));
      url.searchParams.set('bgUrl', bgUrl);   // попробуем iframe
      url.searchParams.set('bg', bgData);     // и фолбэк-картинку

      if (p.name === 'snippet' && (p as any).variant) {
        // пример: snippet=geetest → renderer загрузит ./snippets/geetest.html
        url.searchParams.set('snippet', (p as any).variant);
      }

      await page.goto(url.toString(), { waitUntil: 'load', timeout: 45000 });

      // дождаться iframe капчи
      const sel =
        p.name === 'hcaptcha'  ? 'iframe[src*="hcaptcha"]' :
        p.name === 'turnstile' ? 'iframe[src*="challenges.cloudflare.com"]' :
        p.name === 'recaptcha' ? 'iframe[src*="recaptcha"]' :
                                 '#cap-slot *'; // для snippet ждём любой вложенный элемент
      try { await page.waitForSelector(sel, { timeout: 10000 }); } catch {}

      // опционально «ткнуть» по капче — у hCaptcha часто открывается сетка картинок
      if ((p as any).openChallenge) {
        const box = await page.locator('.cap-wrapper').boundingBox();
        if (box) {
          await page.mouse.click(box.x + Math.min(20, box.width/2), box.y + Math.min(20, box.height/2), { delay: 30 });
          await page.waitForTimeout(800);
        }
      }

      // bbox контейнера
      const rect = await page.evaluate(() => {
        const el = document.querySelector('.cap-wrapper') as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
      });

      // split
      const r = Math.random();
      const split = r < CONFIG.split.train ? 'train' : (r < CONFIG.split.train+CONFIG.split.val ? 'val' : 'test');
      const outDir = path.join(baseOut, split);
      await ensureDir(outDir);

      const ts = new Date().toISOString().replace(/[:.]/g,'-');
      const stem = `${ts}_${String(idx).padStart(5,'0')}`;
      const pngPath = path.join(outDir, `${stem}.png`);
      const metaPath = path.join(outDir, `${stem}.json`);
      const yoloPath = path.join(outDir, `${stem}.txt`);

      await page.screenshot({ path: pngPath, fullPage: true });
      if (CONFIG.yolo && rect) {
        await yoloWrite(yoloPath, CLASS_ID[p.name], rect, CONFIG.viewport.width, CONFIG.viewport.height);
      }

      const meta = { provider: p.name, variant: (p as any).variant||null, size: p.size, theme, lang: hl,
        backgroundUrl: bgUrl, position: {x,y}, viewport: CONFIG.viewport, bbox: rect, createdAt: new Date().toISOString()
      };
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
      idx++;
      process.stdout.write(`Saved ${pngPath}\n`);
    }
  }

  await browser.close();
})();
