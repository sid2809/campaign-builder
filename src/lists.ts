// Google's own lists of countries and languages, fetched once and kept in the database, so the dashboard
// can offer them by full name. Until they are loaded, the forms take codes (US, en) instead.
import type { AppDb } from './db.ts';
import type { AdsPort } from './ads.ts';
import { log } from './log.ts';

export interface ListItem {
  code: string; // what a run stores: the country code (US) or language code (en)
  name: string; // Google's English name
}

export interface Lists {
  countries: ListItem[];
  languages: ListItem[];
}

export async function loadLists(app: AppDb): Promise<Lists | undefined> {
  const saved = await app.getSetting('google_lists');
  return saved ? JSON.parse(saved) : undefined;
}

const RETRY_MINUTES = 30;

// Fetches the lists if they aren't stored yet (2 API operations). `accounts` are tried in order: constants are
// the same for every account, so the first one that answers is enough. A failure is recorded and tried again later.
export async function ensureLists(app: AppDb, adsFor: (customerId: string) => AdsPort, accounts: string[]): Promise<void> {
  if (await app.getSetting('google_lists')) return;
  const lastTry = await app.getSetting('google_lists_tried');
  if (lastTry && Date.now() - Date.parse(lastTry) < RETRY_MINUTES * 60 * 1000) return;
  const quotaUntil = await app.getSetting('google_quota_until');
  if (quotaUntil && Date.parse(quotaUntil) > Date.now()) return;
  await app.setSetting('google_lists_tried', new Date().toISOString());
  let lastError = 'no Google Ads account to ask (add a domain with an account, or set GOOGLE_ADS_LOGIN_CUSTOMER_ID)';
  for (const account of [...new Set(accounts.filter(Boolean))]) {
    try {
      const ads = adsFor(account);
      await app.addOps(2, 'country and language lists');
      const countryRows = await ads.query(
        "SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.country_code FROM geo_target_constant WHERE geo_target_constant.target_type = 'Country' AND geo_target_constant.status = 'ENABLED'",
      );
      const languageRows = await ads.query('SELECT language_constant.id, language_constant.name, language_constant.code FROM language_constant WHERE language_constant.targetable = true');
      const countries = unique(countryRows.map((r) => ({ code: String(r.geo_target_constant?.country_code ?? ''), name: String(r.geo_target_constant?.name ?? '') })));
      const languages = unique(languageRows.map((r) => ({ code: String(r.language_constant?.code ?? ''), name: String(r.language_constant?.name ?? '') })));
      if (countries.length === 0 || languages.length === 0) throw new Error(`Google returned ${countries.length} countries and ${languages.length} languages`);
      await app.setSetting('google_lists', JSON.stringify({ countries, languages } satisfies Lists));
      await app.setSetting('google_lists_error', '');
      log(`lists: ${countries.length} countries and ${languages.length} languages loaded from Google Ads (asked account ${account})`);
      return;
    } catch (error) {
      lastError = `account ${account}: ${(error as Error).message}`.slice(0, 400);
      log(`lists: could not load from Google Ads: ${lastError}`);
    }
  }
  await app.setSetting('google_lists_error', lastError);
}

// One entry per code (a code Google lists twice can't be told apart, so it is left out), sorted by name.
function unique(items: ListItem[]): ListItem[] {
  const count = new Map<string, number>();
  for (const item of items) count.set(item.code, (count.get(item.code) ?? 0) + 1);
  return items.filter((item) => item.code && item.name && count.get(item.code) === 1).sort((a, b) => a.name.localeCompare(b.name));
}

// Problems with a run's countries and languages against Google's lists (none when the lists aren't loaded:
// the preflight then asks Google directly).
export function listProblems(lists: Lists | undefined, countries: string[], languages: string[]): string[] {
  if (!lists) return [];
  const problems: string[] = [];
  for (const c of countries) if (!lists.countries.some((x) => x.code === c)) problems.push(`Country "${c}" is not in Google's list of countries`);
  for (const l of languages) if (!lists.languages.some((x) => x.code === l)) problems.push(`Language "${l}" is not in Google's list of languages`);
  return problems;
}

export const namesOf = (items: ListItem[] | undefined, codes: string[]) => codes.map((code) => items?.find((x) => x.code === code)?.name ?? code).join(', ');
