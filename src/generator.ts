import { chromium } from 'playwright';
import pc from 'picocolors';
import cliProgress from 'cli-progress';

import { readConfig } from './config';
import { prepareBgCache, makeTasks } from './tasks';
import { runOne } from './runner';

(async () => {
  const cfg = await readConfig();

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({ viewport: cfg.viewport });

  // 1) кеш фонов
  const bgCache = await prepareBgCache(ctx, cfg);

  // 2) задачи
  const tasks = makeTasks(cfg.providers);

  // 3) прогресс
  const framesPerTask = cfg.capture === 'both' ? 2 : 1;
  const totalFrames = tasks.length * framesPerTask;

  const bar = new cliProgress.SingleBar({
    format: `${pc.cyan('CAPTCHA')} ${pc.gray('|')} {bar} {percentage}% ${pc.gray('|')} {value}/{total} frames ${pc.gray('|')} ETA: {eta_formatted}`,
    barCompleteChar: pc.green('█'),
    barIncompleteChar: pc.dim('░'),
    hideCursor: true
  });
  bar.start(totalFrames, 0);

  // 4) пул воркеров
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
          if (saved > 0) bar.increment(saved);
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
