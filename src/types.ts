// Тип провайдера
export type Prov = 'recaptcha' | 'hcaptcha' | 'turnstile';

// Тема виджета
export type Theme = 'light' | 'dark';

// Режим съёмки
export type CaptureMode = 'pre' | 'post' | 'both';

// Базовые типы
export interface Viewport { width: number; height: number }
export interface XYRange { min: number; max: number }
export interface Positions { x: XYRange; y: XYRange }
export interface Timeouts { pageLoadMs: number; providerIframeMs: number; afterClickDelayMs: number }
export interface Randomize { theme: Theme[]; languages: string[]; jitter: number }

// Конфиг одного провайдера
export interface ProviderCfg {
  name: Prov;
  count: number;
  size: string;
  variant?: string;
  openChallenge?: boolean;
}

// Разбивка на подпапки или выключено
export type Split = false | { train: number; val: number; test: number };

// Главный конфиг
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
  requireWidget: boolean;
  requireChallengeForPost: boolean;
}

// Классы для YOLO (можешь поменять порядок под себя)
export const CLASS_ID: Record<Prov, number> = {
  recaptcha: 0,
  hcaptcha: 1,
  turnstile: 2
};
