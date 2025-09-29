import { promises as fs } from 'fs';
import { Config, ProviderCfg, Viewport, Positions, Randomize, Timeouts } from './types';

// Берём значение аргумента CLI (например, --config path/to.json)
export function getArg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}

function isProv(v: unknown): v is ProviderCfg['name'] {
  return v === 'recaptcha' || v === 'hcaptcha' || v === 'turnstile';
}

function applyDefaults(partial: Partial<Config>): Config {
  const viewport: Viewport = partial.viewport ?? { width: 1280, height: 800 };

  const positions: Positions = partial.positions ?? {
    x: { min: 24, max: Math.max(24, viewport.width - 300) },
    y: { min: 96, max: Math.max(96, viewport.height - 200) }
  };

  const randomize: Randomize = partial.randomize ?? {
    theme: ['light', 'dark'],
    languages: ['en'],
    jitter: 0
  };

  const timeouts: Timeouts = partial.timeouts ?? {
    pageLoadMs: 15000,
    providerIframeMs: 8000,
    afterClickDelayMs: 800
  };

  const cfg: Config = {
    outDir: partial.outDir ?? 'out',
    viewport,
    backgrounds: Array.isArray(partial.backgrounds) ? partial.backgrounds : [],
    providers: Array.isArray(partial.providers) ? (partial.providers as ProviderCfg[]) : [],
    positions,
    randomize,
    split: (partial.split ?? false) as Config['split'],
    yolo: Boolean(partial.yolo ?? false),
    includeChallengeBBox: Boolean(partial.includeChallengeBBox ?? true),
    capture: (partial.capture ?? 'both') as Config['capture'],
    fullPage: Boolean(partial.fullPage ?? false),
    concurrency: Number(partial.concurrency ?? 4),
    disableIframeBackground: Boolean(partial.disableIframeBackground ?? true),
    retries: Number(partial.retries ?? 1),
    timeouts,
    rendererUrl: String(partial.rendererUrl ?? 'https://keofoxy.github.io/captcha-generator/index.html'),
    requireWidget: Boolean(partial.requireWidget ?? true),
    requireChallengeForPost: Boolean(partial.requireChallengeForPost ?? true)
  };

  // Минимальная валидация
  if (!cfg.backgrounds.length) throw new Error('config.backgrounds must be a non-empty array');
  if (!cfg.providers.length) throw new Error('config.providers must be a non-empty array');

  for (const p of cfg.providers) {
    if (!isProv(p.name)) throw new Error('providers[].name must be recaptcha|hcaptcha|turnstile');
    if (!Number.isInteger(p.count) || p.count <= 0) throw new Error('providers[].count must be positive integer');
  }

  if (cfg.split && typeof cfg.split === 'object') {
    const s = cfg.split; const sum = s.train + s.val + s.test;
    if (Math.abs(sum - 1) > 1e-6) throw new Error('split: train+val+test must sum to 1, or set split=false');
  }

  return cfg;
}

export async function readConfig(): Promise<Config> {
  const configPath = getArg('--config', 'config.json')!;
  const raw = await fs.readFile(configPath, 'utf-8');
  const json = JSON.parse(raw) as Partial<Config>;
  return applyDefaults(json);
}
