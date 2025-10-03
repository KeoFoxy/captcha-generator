import path from 'path';
import pc from 'picocolors';
import { promises as fs } from 'fs';
import type { Page } from 'playwright';

import {
  Config,
  Prov,
  Theme,
  CLASS_ID,
  Task,
} from './types.js';
import {
  pick,
  rand,
  safeGoto,
  setBackgroundImage,
  waitForStableFrame,
  getWrapperBBox,
  getChallengeBBox,
  yoloWrite,
  waitNextPaint,
} from './utils.js';
import { prepareOutDir } from './tasks.js';
import { getProviderSelectors } from './selectors.js';
import {
  tryOpenHcaptcha,
  tryOpenRecaptchaV2,
  tryOpenTurnstile,
} from './openers.js';

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

  // Надёжно ждём стабильный виджет (не полупрозрачный, не прыгающий)
  const widgetBB = await waitForStableFrame(page, widgetFrame, {
    timeout: cfg.timeouts.providerIframeMs,
    minArea: 2500,
    minOpacity: 0.95,
    stableMs: 280
  });

  if (!widgetBB && cfg.requireWidget) {
    console.error(pc.yellow(`[skip] widget not detected for ${t.prov}`));
    return 0;
  }

  const baseOut = await prepareOutDir(cfg, t.prov);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const stemBase = `${ts}_${String(globalIdx).padStart(6, '0')}`;

  let framesSaved = 0;

  // --- PRE (дожимаем виджет ещё чуть-чуть и снимаем)
  if (cfg.capture === 'pre' || cfg.capture === 'both') {
    if (!widgetBB && cfg.requireWidget) {
      // skip
    } else {
      await waitForStableFrame(page, widgetFrame, {
        timeout: 1500,
        minArea: 2200,
        minOpacity: 0.95,
        stableMs: 220
      }).catch(() => null);

      // добить анимации
      await waitNextPaint(page);
      await page.waitForTimeout(150);

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

  // --- POST
  if (cfg.capture === 'post' || cfg.capture === 'both') {
    let opened = false;
    if (t.pCfg.openChallenge) {
      if (t.prov === 'hcaptcha') opened = await tryOpenHcaptcha(page, cfg.timeouts.afterClickDelayMs, cfg.timeouts.providerIframeMs);
      else if (t.prov === 'recaptcha') opened = await tryOpenRecaptchaV2(page, cfg.timeouts.afterClickDelayMs, cfg.timeouts.providerIframeMs);
      else if (t.prov === 'turnstile') opened = await tryOpenTurnstile(page, cfg.timeouts.afterClickDelayMs, cfg.timeouts.providerIframeMs);
    }

    if (cfg.requireChallengeForPost && challengeFrame?.length) {
      const chBB = await waitForStableFrame(page, challengeFrame, {
        timeout: cfg.timeouts.providerIframeMs,
        minArea: 12000,
        minOpacity: 0.95,
        stableMs: 300
      });
      if (!chBB) {
        console.error(pc.yellow(`[skip] challenge not detected for ${t.prov} (post)`));
        return framesSaved;
      }
    } else {
      // иначе хотя бы стабилизируем виджет ещё раз
      await waitForStableFrame(page, widgetFrame, {
        timeout: 1500, minArea: 2500, minOpacity: 0.95, stableMs: 200
      }).catch(()=>null);
    }

    await waitNextPaint(page);
    await page.waitForTimeout(200);

    await savePost(baseOut, stemBase, page, cfg, t.prov, x, y, theme, hl, bgUrl, opened, t.pCfg.variant, t.pCfg.size);
    framesSaved++;
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
  opened: boolean,
  variant?: string,
  size?: string
) {
  const rect = await getWrapperBBox(page);
  const postPng  = path.join(baseOut, `${stemBase}_post.png`);
  const postMeta = path.join(baseOut, `${stemBase}_post.json`);
  const postYolo = path.join(baseOut, `${stemBase}_post.txt`);
  const challengeRect = cfg.includeChallengeBBox ? await getChallengeBBox(page, prov) : null;

  await page.screenshot({ path: postPng, fullPage: cfg.fullPage });

  if (cfg.yolo && rect) {
    await yoloWrite(postYolo, CLASS_ID[prov], rect, cfg.viewport.width, cfg.viewport.height);
  }

  await fs.writeFile(postMeta, JSON.stringify({
    provider: prov,
    variant: variant ?? null,
    size: size || 'normal',
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
