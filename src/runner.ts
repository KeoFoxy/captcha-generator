import path from 'path';
import pc from 'picocolors';
import { promises as fs } from 'fs';
import { Page } from 'playwright';

import {
  Config,
  Prov,
  Theme,
  CLASS_ID,
  Task,
} from './types';
import {
  pick,
  rand,
  safeGoto,
  setBackgroundImage,
  waitForVisibleFrame,
  getWrapperBBox,
  getChallengeBBox,
  yoloWrite,
} from './utils';
import { prepareOutDir } from './tasks';
import { getProviderSelectors } from './selectors';
import {
  tryOpenHcaptcha,
  tryOpenRecaptchaV2,
  tryOpenTurnstile,
} from './openers';

export async function runOne(
  page: Page,
  bgCache: Map<string, string>,
  cfg: Config,
  t: Task,
  globalIdx: number
): Promise<number> {
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
  await setBackgroundImage(page, bgData);

  const { widgetFrame, challengeFrame } = getProviderSelectors(t.prov);
  const widgetBB = await waitForVisibleFrame(page, widgetFrame, cfg.timeouts.providerIframeMs);

  if (!widgetBB) {
    if (cfg.requireWidget) {
      console.error(pc.yellow(`[skip] widget not detected for ${t.prov}`));
      return 0;
    } else {
      console.warn(pc.yellow(`[warn] widget not detected for ${t.prov}, but requireWidget=false`));
    }
  }

  const baseOut = await prepareOutDir(cfg, t.prov);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const stemBase = `${ts}_${String(globalIdx).padStart(6, '0')}`;

  let framesSaved = 0;

  // PRE
  if (cfg.capture === 'pre' || cfg.capture === 'both') {
    if (!widgetBB && cfg.requireWidget) {
      // skip
    } else {
      const rect = await getWrapperBBox(page);
      const prePng = path.join(baseOut, `${stemBase}_pre.png`);
      const preMeta = path.join(baseOut, `${stemBase}_pre.json`);
      const preYolo = path.join(baseOut, `${stemBase}_pre.txt`);

      await page.screenshot({ path: prePng, fullPage: cfg.fullPage });
      framesSaved++;

      if (cfg.yolo && rect) {
        await yoloWrite(preYolo, CLASS_ID[t.prov], rect, cfg.viewport.width, cfg.viewport.height);
      }

      await fs.writeFile(preMeta, JSON.stringify({
        provider: t.prov,
        variant: t.pCfg.variant ?? null,
        size: t.pCfg.size || 'normal',
        state: 'pre',
        theme, lang: hl,
        backgroundUrl: bgUrl,
        position: { x, y },
        viewport: cfg.viewport,
        bbox: rect,
        createdAt: new Date().toISOString()
      }, null, 2));
    }
  }

  // POST
  if (cfg.capture === 'post' || cfg.capture === 'both') {
    let opened = false;
    if (t.pCfg.openChallenge) {
      if (t.prov === 'hcaptcha') opened = await tryOpenHcaptcha(page, cfg.timeouts.afterClickDelayMs, cfg.timeouts.providerIframeMs);
      else if (t.prov === 'recaptcha') opened = await tryOpenRecaptchaV2(page, cfg.timeouts.afterClickDelayMs, cfg.timeouts.providerIframeMs);
      else if (t.prov === 'turnstile') opened = await tryOpenTurnstile(page, cfg.timeouts.afterClickDelayMs, cfg.timeouts.providerIframeMs);
    }

    if (cfg.requireChallengeForPost && challengeFrame) {
      const chBB = await waitForVisibleFrame(page, challengeFrame, cfg.timeouts.providerIframeMs);
      if (!chBB) {
        console.error(pc.yellow(`[skip] challenge not detected for ${t.prov} (post)`));
      } else {
        await savePost(baseOut, stemBase, page, cfg, t.prov, x, y, theme, hl, bgUrl, opened);
        framesSaved++;
      }
    } else {
      await savePost(baseOut, stemBase, page, cfg, t.prov, x, y, theme, hl, bgUrl, opened);
      framesSaved++;
    }
  }

  return framesSaved;
}

async function savePost(
  baseOut: string,
  stemBase: string,
  page: Page,
  cfg: Config,
  prov: Prov,
  x: number,
  y: number,
  theme: string,
  hl: string,
  bgUrl: string,
  opened: boolean
) {
  const rect = await getWrapperBBox(page);
  const postPng = path.join(baseOut, `${stemBase}_post.png`);
  const postMeta = path.join(baseOut, `${stemBase}_post.json`);
  const postYolo = path.join(baseOut, `${stemBase}_post.txt`);
  const challengeRect = cfg.includeChallengeBBox ? await getChallengeBBox(page, prov) : null;

  await page.screenshot({ path: postPng, fullPage: cfg.fullPage });
  if (cfg.yolo && rect) {
    await yoloWrite(postYolo, CLASS_ID[prov], rect, cfg.viewport.width, cfg.viewport.height);
  }

  await fs.writeFile(postMeta, JSON.stringify({
    provider: prov,
    variant: null,
    size: 'normal',
    state: 'post',
    challengeOpened: opened,
    challengeBBox: challengeRect,
    theme, lang: hl,
    backgroundUrl: bgUrl,
    position: { x, y },
    viewport: cfg.viewport,
    bbox: rect,
    createdAt: new Date().toISOString()
  }, null, 2));
}
