import { DEFAULT_MODEL, MATCH_TYPES, MAX_ADS_PER_AD_GROUP, MODELS, type MatchType } from './config.ts';

// Everything one run can set. A domain stores the same shape as its defaults.
export interface RunSettings {
  account: string; // Google Ads account ID under the MCC, e.g. 197-844-9758
  labels: string[]; // one or several
  namePattern: string; // {theme} and {number} are replaced
  numbering: 'restart' | 'continue'; // restart at 0001, or continue after the domain's last number
  maxCpc: number; // Maximize Clicks, CPC capped at this (account currency)
  budget: number; // per campaign, per day (account currency)
  countries: string[]; // 2-letter country codes, resolved by Google at preflight
  languages: string[]; // language codes (e.g. en), resolved by Google at preflight
  matchType: MatchType;
  adsPerAdGroup: number;
  adGroupsPerCampaign: number;
  pilot: number; // campaigns in the pilot; 0 = no pilot
  review: boolean; // stop for theme confirmation and Approve
  copyRules: string; // empty = the app default
  model: string;
}

export const DEFAULT_SETTINGS: RunSettings = {
  account: '',
  labels: [],
  namePattern: '{theme} | {number}',
  numbering: 'restart',
  maxCpc: 3,
  budget: 2700,
  countries: ['US'],
  languages: ['en'],
  matchType: 'PHRASE',
  adsPerAdGroup: 3,
  adGroupsPerCampaign: 4,
  pilot: 0,
  review: true,
  copyRules: '',
  model: DEFAULT_MODEL,
};

const list = (value: unknown): string[] =>
  String(value ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

// Reads a settings form. Returns the settings and every problem found (nothing is guessed or corrected silently).
export function parseSettings(form: Record<string, string | undefined>, forRun: boolean): { settings: RunSettings; problems: string[] } {
  const problems: string[] = [];
  const number = (key: string, label: string, min: number, max: number, whole: boolean): number => {
    const raw = (form[key] ?? '').trim();
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n) || n < min || n > max || (whole && !Number.isInteger(n))) {
      problems.push(`${label}: "${raw}" is not ${whole ? 'a whole number' : 'a number'} from ${min} to ${max}`);
      return min;
    }
    return n;
  };
  const account = (form.account ?? '').trim();
  if (account && !/^\d{3}-?\d{3}-?\d{4}$/.test(account)) problems.push(`Account: "${account}" is not a Google Ads account ID (10 digits, e.g. 197-844-9758)`);
  if (forRun && !account) problems.push('Account: required');
  const labels = [...new Set(list(form.labels))];
  if (forRun && labels.length === 0) problems.push('Labels: at least one label is required');
  for (const l of labels) if (l.length > 80) problems.push(`Label "${l.slice(0, 20)}…" is longer than 80 characters`);
  const namePattern = (form.namePattern ?? '').trim();
  if (!namePattern.includes('{theme}') || !namePattern.includes('{number}')) problems.push('Campaign name pattern: must contain {theme} and {number}');
  const numbering = form.numbering === 'continue' ? 'continue' : form.numbering === 'restart' ? 'restart' : undefined;
  if (!numbering) problems.push('Numbering: choose restart or continue');
  const countries = [...new Set(list(form.countries).map((c) => c.toUpperCase()))];
  if (countries.length === 0) problems.push('Countries: at least one is required');
  for (const c of countries) if (!/^[A-Z]{2}$/.test(c)) problems.push(`Country "${c}" is not a 2-letter code (e.g. US, GB, CA)`);
  const languages = [...new Set(list(form.languages))];
  if (languages.length === 0) problems.push('Languages: at least one is required');
  for (const c of languages) if (!/^[a-z]{2,3}([_-][a-z0-9]{2,4})?$/i.test(c)) problems.push(`Language "${c}" is not a language code (e.g. en, es)`);
  const matchType = MATCH_TYPES.find((m) => m === form.matchType);
  if (!matchType) problems.push('Match type: choose phrase, exact or broad');
  const model = (MODELS as readonly string[]).includes(form.model ?? '') ? form.model! : undefined;
  if (!model) problems.push('Model: choose one from the list');
  const review = form.review === 'yes' ? true : form.review === 'no' ? false : undefined;
  if (review === undefined) problems.push('Review before publishing: choose yes or no');
  const settings: RunSettings = {
    account,
    labels,
    namePattern,
    numbering: numbering ?? 'restart',
    maxCpc: number('maxCpc', 'Max CPC cap', 0.01, 100000, false),
    budget: number('budget', 'Daily budget per campaign', 1, 100000000, false),
    countries,
    languages,
    matchType: matchType ?? 'PHRASE',
    adsPerAdGroup: number('adsPerAdGroup', 'Ads per ad group', 1, MAX_ADS_PER_AD_GROUP, true),
    adGroupsPerCampaign: number('adGroupsPerCampaign', 'Ad groups per campaign', 1, 100, true),
    pilot: number('pilot', 'Pilot campaigns', 0, 100000, true),
    review: review ?? true,
    copyRules: (form.copyRules ?? '').trim(),
    model: model ?? DEFAULT_MODEL,
  };
  return { settings, problems };
}

export function settingsToForm(s: RunSettings): Record<string, string> {
  return {
    account: s.account,
    labels: s.labels.join(', '),
    namePattern: s.namePattern,
    numbering: s.numbering,
    maxCpc: String(s.maxCpc),
    budget: String(s.budget),
    countries: s.countries.join(', '),
    languages: s.languages.join(', '),
    matchType: s.matchType,
    adsPerAdGroup: String(s.adsPerAdGroup),
    adGroupsPerCampaign: String(s.adGroupsPerCampaign),
    pilot: String(s.pilot),
    review: s.review ? 'yes' : 'no',
    copyRules: s.copyRules,
    model: s.model,
  };
}

export function campaignName(pattern: string, theme: string, number: number): string {
  return pattern.replaceAll('{theme}', theme).replaceAll('{number}', String(number).padStart(4, '0'));
}
