import path from 'path';
import { BrowserContext } from 'playwright';
import { promises as fs } from 'fs';
import { Config, Prov, ProviderCfg, Split } from './types';
import { screenshotDataUri, ensureDir } from './utils';

// Описание «задачи»: один кейс конкретного провайдера
export interface Task { prov: Prov; pCfg: ProviderCfg; idx: number }

// Формируем очередь задач по counts, перемешиваем
export function makeTasks(providers: ProviderCfg[]): Task[] {
  const tasks: Task[] = [];
  for (const p of providers) for (let i = 0; i < p.count; i++) tasks.push({ prov: p.name, pCfg: p, idx: i });
  for (let i = tasks.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [tasks[i], tasks[j]] = [tasks[j], tasks[i]]; }
  return tasks;
}

// Выбираем подпапку согласно split
export function chooseSplitDir(split: Split): 'train' | 'val' | 'test' | null {
  if (!split) return null;
  const r = Math.random();
  return r < split.train ? 'train' : (r < split.train + split.val ? 'val' : 'test');
}

// Предварительно снимаем скрины всех backgrounds и кладём в кэш (Map url -> data:uri)
export async function prepareBgCache(ctx: BrowserContext, cfg: Config): Promise<Map<string, string>> {
  const page = await ctx.newPage();
  const cache = new Map<string, string>();
  for (const url of Array.from(new Set(cfg.backgrounds))) {
    try {
      const data = await screenshotDataUri(page, url, cfg.viewport.width, cfg.viewport.height, cfg.timeouts.pageLoadMs, cfg.fullPage);
      cache.set(url, data);
      process.stdout.write(`[bg cached] ${url}\n`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[bg fail]', url, msg);
    }
  }
  await page.close().catch(() => {});
  return cache;
}

// Утилита: создать базовую папку вывода под провайдера (+ split при необходимости)
export async function prepareOutDir(cfg: Config, prov: Prov) {
  const splitDir = chooseSplitDir(cfg.split);
  const baseOut = splitDir ? path.join(cfg.outDir, prov, splitDir) : path.join(cfg.outDir, prov);
  await ensureDir(baseOut);
  return baseOut;
}
