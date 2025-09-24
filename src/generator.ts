import { chromium, Page } from 'playwright';
import { promises as fs } from 'fs';
import path from 'path';

const RENDER_URL_BASE = 'https://keofoxy.github.io/captcha-generator/index.html'; // ЯВНО на файл

const CONFIG = {
  outDir: 'out',
  viewport: { width: 1280, height: 800 },

  // URL-ы для <iframe> (если сайт запретит встраивание — фон всё равно будет через картинку)
  backgrounds: [
    'https://www.wikipedia.org/',
    'https://developer.mozilla.org/',
  ],

  // Включай только те провайдеры, на которые ВСТАВЛЕНЫ прод-ключи в index.html
  providers: [
    { name: 'hcaptcha'  as const, count: 20, size: 'normal', variant: 'checkbox', openChallenge: true  },
    { name: 'turnstile' as const, count: 20, size: 'auto',   variant: 'interactive', openChallenge: false },
    { name: 'recaptcha' as const, count: 10, size: 'normal', variant: 'checkbox', openChallenge: true  },
    // { name: 'snippet'   as const, count: 10, size: 'normal', variant: 'geetest',   openChallenge: true  },
  ],

  positions: { x: { min: 24, max: 980 }, y: { min: 96, max: 640 } },
  randomize: { theme: ['light','dark'] as const, languages: ['en','ru','es'], jitter: 6 },
  split: { train: 0.8, val: 0.1, test: 0.1 },
  yolo: true,

  timeouts: {
    pageLoadMs: 45000,
    providerIframeMs: 12000,
    afterClickDelayMs: 900
  }
};

type Prov = 'recaptcha'|'hcaptcha'|'turnstile'|'snippet';
const CLASS_ID: Record<Prov, number> = { recaptcha:0, hcaptcha:1, turnstile:2, snippet:3 };

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

(async () => {
  await ensureDir(CONFIG.outDir);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: CONFIG.viewport });

  // отдельная вкладка — делаем скрин фона (для картинки)
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
        // короткий URL (без огромного bg=)
        const u = new URL(RENDER_URL_BASE);
        u.searchParams.set('prov', p.name as any);
        u.searchParams.set('size', (p as any).size || 'normal');
        u.searchParams.set('variant', (p as any).variant || 'checkbox');
        u.searchParams.set('theme', theme);
        u.searchParams.set('hl', hl);
        u.searchParams.set('x', String(x));
        u.searchParams.set('y', String(y));
        u.searchParams.set('bgUrl', bgUrl);
        // if (p.name === 'snippet' && (p as any).variant) {
        //   u.searchParams.set('snippet', (p as any).variant);
        // }

        await safeGoto(page, u.toString(), CONFIG.timeouts.pageLoadMs);

        // теперь аккуратно подставляем КАРТИНКУ фона напрямую в DOM (без URL)
        await page.evaluate((dataUri) => {
          const img = document.getElementById('bgImg') as HTMLImageElement | null;
          if (img) img.src = dataUri;
        }, bgData);

        // ждём iframe провайдера
        const iframeSel =
          p.name === 'hcaptcha'  ? 'iframe[src*="hcaptcha"]' :
          p.name === 'turnstile' ? 'iframe[src*="challenges.cloudflare.com"]' :
          p.name === 'recaptcha' ? 'iframe[src*="recaptcha"]' :
                                   '#cap-slot *';
        try { await page.waitForSelector(iframeSel, { timeout: CONFIG.timeouts.providerIframeMs }); } catch {}

        // кликаем по ЦЕНТРУ iframe (раскрыть сетку картинок у hCaptcha)
        if ((p as any).openChallenge) {
          const ibox = await page.locator(iframeSel).boundingBox().catch(()=>null);
          if (ibox) {
            await page.mouse.click(ibox.x + ibox.width/2, ibox.y + ibox.height/2, { delay: 30 });
            await page.waitForTimeout(CONFIG.timeouts.afterClickDelayMs);
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
        if (CONFIG.yolo && rect) await yoloWrite(yoloPath, CLASS_ID[p.name], rect, CONFIG.viewport.width, CONFIG.viewport.height);

        const meta = { provider: p.name, variant: (p as any).variant||null, size: (p as any).size||'normal',
          theme, lang: hl, backgroundUrl: bgUrl, position: {x,y}, viewport: CONFIG.viewport, bbox: rect, createdAt: new Date().toISOString()
        };
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));

        idx++;
        process.stdout.write(`Saved ${pngPath}\n`);
      } catch (e:any) {
        console.error('[WARN]', e?.message || e);
      } finally {
        await page.close().catch(()=>{});
      }
    }
  }

  await browser.close();
})();
