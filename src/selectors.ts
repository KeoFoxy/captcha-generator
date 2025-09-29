import { Prov } from './types';

// Селекторы для проверки наличия виджета и челленджа
export function getProviderSelectors(prov: Prov): {
  widgetFrame: string;
  challengeFrame?: string;
} {
  if (prov === 'hcaptcha') {
    return {
      widgetFrame: 'iframe[src*="hcaptcha"]',
      challengeFrame: 'iframe[src*="hcaptcha"][title*="challenge"], iframe[title*="hCaptcha challenge"]'
    };
  }
  if (prov === 'recaptcha') {
    return {
      widgetFrame: 'iframe[src*="api2/anchor"]',
      challengeFrame: 'iframe[src*="api2/bframe"]'
    };
  }
  // turnstile
  return {
    widgetFrame: 'iframe[src*="challenges.cloudflare.com"]',
    // challengeFrame: (обычно нет отдельного)
  };
}
