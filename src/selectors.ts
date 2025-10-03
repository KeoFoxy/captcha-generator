import { Prov } from './types';

export function getProviderSelectors(prov: Prov): {
  widgetFrame: string[];
  challengeFrame?: string[];
} {
  switch (prov) {
    case 'hcaptcha':
      return {
        widgetFrame: [
          'iframe[title*="hcaptcha" i]',
          'iframe[src*="hcaptcha.com" i]'
        ],
        challengeFrame: [
          'iframe[title*="hcaptcha challenge" i]',
          'iframe[title*="challenge" i][src*="hcaptcha.com" i]'
        ]
      };
    case 'recaptcha':
      return {
        widgetFrame: [
          'iframe[src*="api2/anchor"]',
          'iframe[title="reCAPTCHA"]'
        ],
        challengeFrame: [
          'iframe[src*="api2/bframe"]'
        ]
      };
    case 'turnstile':
      return {
        widgetFrame: [
          'iframe[src*="challenges.cloudflare.com" i]',
          'iframe[id^="cf-chl-widget-"]',
          'iframe[title*="cloudflare security" i]'
        ]
      };
  }
}
