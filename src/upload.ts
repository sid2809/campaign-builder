// From the rsa repo (src/upload.ts), working per run: the label, location and language come from the run's
// settings, and the run's own campaign IDs (not a label) say which campaigns are its own.
import { enums } from 'google-ads-api';
import type { AppDb, RunDb } from './db.ts';
import {
  type AdsPort,
  type CampaignPlan,
  type Targets,
  AdsError,
  adsFromArticles,
  campaignOperations,
  topUpOperations,
  idFromResourceName,
  gaqlString,
  isQuotaError,
  isRetryableError,
  quotaRetrySeconds,
  toMicros,
  cleanCustomerId,
  keywordKey,
} from './ads.ts';
import { RSA_FINAL_URL_SUFFIX, SYNC_RESERVE, UPLOAD_MAX_ATTEMPTS, WAVES, type Wave } from './config.ts';
import type { RunSettings } from './settings.ts';
import { log } from './log.ts';

export class QuotaReached extends Error {}

// Checks the 24-hour operation budget (shared by every run) before any Google Ads call. Every call is counted.
// `reserve` keeps operations free under the cap (uploads leave room for the sync).
export async function spend(app: AppDb, cap: number, count: number, kind: string, runId: number, reserve = 0): Promise<void> {
  const used = await app.opsLast24h();
  if (used + count > cap - reserve) throw new QuotaReached(`daily API cap ${cap} reached (${used} used in the last 24 h, ${count} more needed for ${kind})`);
  await app.addOps(count, kind, runId);
}

// Google refused for quota: wait until the time Google gives; the refused call isn't counted, no try is used.
export async function googleQuotaExhausted(app: AppDb, error: AdsError, refund: number, runId: number): Promise<QuotaReached> {
  await app.addOps(-refund, 'refused by Google (quota)', runId);
  const until = new Date(Date.now() + quotaRetrySeconds(error) * 1000);
  await app.setSetting('google_quota_until', until.toISOString());
  return new QuotaReached(`Google's daily API limit for the developer token is used up (shared with other tools on it). Resuming at ${until.toISOString()}`);
}

const rowsToOps = (rows: number) => Math.max(1, Math.ceil(rows / 10000));

async function queryCounted(db: RunDb, ads: AdsPort, cap: number, gaql: string, kind: string): Promise<Record<string, any>[]> {
  await spend(db.app, cap, 1, kind, db.runId);
  const rows = await ads.query(gaql);
  await db.app.addOps(rowsToOps(rows.length) - 1, kind, db.runId);
  return rows;
}

const gaqlList = (values: string[]) => values.map(gaqlString).join(', ');

// ---------- labels, locations, languages ----------
// Asks Google for the run's labels (creating the missing ones), countries and languages. Saved once per run.
export async function resolveTargets(db: RunDb, ads: AdsPort, settings: RunSettings, cap: number): Promise<Targets> {
  const saved = await db.get('targets');
  if (saved) return JSON.parse(saved);

  const countryRows = await queryCounted(
    db,
    ads,
    cap,
    `SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.country_code FROM geo_target_constant
     WHERE geo_target_constant.country_code IN (${gaqlList(settings.countries)}) AND geo_target_constant.target_type = 'Country' AND geo_target_constant.status = 'ENABLED'`,
    'countries lookup',
  );
  const locationIds: string[] = [];
  const names: string[] = [];
  for (const code of settings.countries) {
    const found = countryRows.filter((r) => String(r.geo_target_constant?.country_code).toUpperCase() === code);
    if (found.length !== 1) throw new Error(`country "${code}": Google returned ${found.length} matching countries (expected exactly 1)`);
    locationIds.push(String(found[0].geo_target_constant.id));
    names.push(String(found[0].geo_target_constant.name));
  }

  const languageRows = await queryCounted(
    db,
    ads,
    cap,
    `SELECT language_constant.id, language_constant.name, language_constant.code FROM language_constant
     WHERE language_constant.code IN (${gaqlList(settings.languages)}) AND language_constant.targetable = true`,
    'languages lookup',
  );
  const languageIds: string[] = [];
  for (const code of settings.languages) {
    const found = languageRows.filter((r) => String(r.language_constant?.code).toLowerCase() === code.toLowerCase());
    if (found.length !== 1) throw new Error(`language "${code}": Google returned ${found.length} matching targetable languages (expected exactly 1)`);
    languageIds.push(String(found[0].language_constant.id));
    names.push(String(found[0].language_constant.name));
  }

  const labels: string[] = [];
  for (const label of settings.labels) {
    const rows = await queryCounted(db, ads, cap, `SELECT label.resource_name, label.name FROM label WHERE label.name = ${gaqlString(label)} AND label.status = 'ENABLED'`, 'label lookup');
    let resource = rows[0]?.label?.resource_name as string | undefined;
    if (!resource) {
      await spend(db.app, cap, 1, 'label create', db.runId);
      [resource] = await ads.mutate([{ entity: 'label', operation: 'create', resource: { name: label } }]);
      log(`run ${db.runId}: label "${label}" created`);
    }
    labels.push(resource!);
  }
  const targets: Targets = { labels, locationIds, languageIds };
  await db.set('targets', JSON.stringify(targets));
  await db.set('targets_names', names.join(', '));
  return targets;
}

// ---------- campaigns already in the account ----------
// Campaign names must be unique among an account's enabled and paused campaigns.
// Returns the run's campaign names that are already in the account, with their IDs.
export async function campaignsInAccount(db: RunDb, ads: AdsPort, cap: number, names: string[]): Promise<Map<string, string>> {
  const wanted = new Set(names);
  const rows = await queryCounted(db, ads, cap, "SELECT campaign.id, campaign.name FROM campaign WHERE campaign.status != 'REMOVED'", 'campaign names');
  const found = new Map<string, string>();
  for (const r of rows) if (wanted.has(String(r.campaign.name))) found.set(String(r.campaign.name), String(r.campaign.id));
  return found;
}

// ---------- preflight ----------
// Runs once per run before its first upload. Any failure stops the run's uploads; the reason is shown on the run page.
export async function preflight(db: RunDb, ads: AdsPort, settings: RunSettings, cap: number): Promise<string[]> {
  const notes: string[] = [];
  await spend(db.app, cap, 1, 'preflight account', db.runId);
  const [account] = await ads.query('SELECT customer.currency_code, customer.auto_tagging_enabled, customer.descriptive_name FROM customer');
  const currency = account?.customer?.currency_code;
  if (currency !== 'INR') throw new Error(`account currency is ${currency}, expected INR (budgets and CPC caps are entered in rupees)`);
  notes.push(`account "${account?.customer?.descriptive_name}", currency INR`);
  notes.push(account?.customer?.auto_tagging_enabled ? 'auto-tagging is ON (gclid will be added)' : 'auto-tagging is OFF: no gclid on clicks');

  const targets = await resolveTargets(db, ads, settings, cap);
  notes.push(`labels, countries and languages found in Google Ads (${await db.get('targets_names')})`);

  // No campaign of this run may already exist in the account under the same name.
  if ((await db.get('names_checked')) !== '1') {
    const clashes = await campaignsInAccount(db, ads, cap, (await db.campaigns()).map((c) => c.name));
    if (clashes.size > 0) {
      const sample = [...clashes.keys()].slice(0, 5).join('", "');
      throw new Error(`${clashes.size} campaign names of this run already exist in the account (e.g. "${sample}"). Google does not allow two campaigns with the same name. Change the name pattern or use "continue" numbering in a new run`);
    }
    await db.set('names_checked', '1');
    notes.push('no campaign name of this run exists in the account yet');
  }

  // 1. Check a real campaign of the run against Google's rules, without creating it.
  let first;
  for (const wave of WAVES) first ??= (await db.campaignsToUpload(wave, UPLOAD_MAX_ATTEMPTS))[0];
  if (first) {
    const articles = (await db.articlesOf(first.name)).filter((a) => a.copy_status === 'done');
    const plan = campaignOperations(settings.account, first.name, adsFromArticles(articles), settings, targets);
    await spend(db.app, cap, plan.operations.length, 'preflight validate', db.runId);
    try {
      await ads.mutate(plan.operations, { validateOnly: true });
      notes.push(`validate-only check of "${first.name}" (${plan.operations.length} operations) passed`);
    } catch (error) {
      if (!(error instanceof AdsError)) throw error;
      if (isQuotaError(error)) throw await googleQuotaExhausted(db.app, error, plan.operations.length, db.runId);
      // Rejected ads or keywords don't stop the run: the upload leaves them out and reports them.
      // Anything else (campaign, budget, label, ad group settings) does.
      const roles = error.failures.map((f) => (f.index === undefined ? undefined : plan.roles[f.index]));
      if (error.failures.length === 0 || roles.some((r) => !r || r.kind === 'campaign' || r.kind === 'ad_group')) throw error;
      notes.push(`validate-only check of "${first.name}": campaign settings OK; Google would reject ${error.failures.length} ad/keyword(s): ${error.message.slice(0, 200)}`);
    }
  }

  // 2. Create a test campaign (no ads), read its settings back from Google, then remove it.
  const testName = `Campaign Builder preflight test ${new Date().toISOString()}`;
  const testPlan = campaignOperations(settings.account, testName, [], settings, targets);
  await spend(db.app, cap, testPlan.operations.length, 'preflight test campaign', db.runId);
  const created = await ads.mutate(testPlan.operations);
  const [budgetName, campaignName] = created;
  try {
    await spend(db.app, cap, 3, 'preflight read back', db.runId);
    const [row] = await ads.query(
      `SELECT campaign.status, campaign.advertising_channel_type, campaign.network_settings.target_google_search,
              campaign.network_settings.target_search_network, campaign.network_settings.target_content_network,
              campaign.network_settings.target_partner_search_network, campaign.target_spend.cpc_bid_ceiling_micros,
              campaign.geo_target_type_setting.positive_geo_target_type, campaign.final_url_suffix,
              campaign_budget.amount_micros
       FROM campaign WHERE campaign.resource_name = ${gaqlString(campaignName)}`,
    );
    const criteria = await ads.query(
      `SELECT campaign_criterion.type, campaign_criterion.location.geo_target_constant, campaign_criterion.language.language_constant
       FROM campaign_criterion WHERE campaign.resource_name = ${gaqlString(campaignName)}`,
    );
    const labelRows = await ads.query(`SELECT campaign_label.label FROM campaign_label WHERE campaign.resource_name = ${gaqlString(campaignName)}`);
    const c = row?.campaign ?? {};
    const problems: string[] = [];
    const expect = (ok: boolean, what: string) => {
      if (!ok) problems.push(what);
    };
    expect(isEnum(c.status, 'PAUSED'), `status ${c.status}`);
    expect(isEnum(c.advertising_channel_type, 'SEARCH'), `channel ${c.advertising_channel_type}`);
    expect(c.network_settings?.target_google_search === true, 'Google Search not on');
    expect(!c.network_settings?.target_search_network, 'search partners on');
    expect(!c.network_settings?.target_content_network, 'Display Network on');
    expect(!c.network_settings?.target_partner_search_network, 'partner search on');
    expect(Number(c.target_spend?.cpc_bid_ceiling_micros) === toMicros(settings.maxCpc), `CPC cap ${c.target_spend?.cpc_bid_ceiling_micros}`);
    expect(isEnum(c.geo_target_type_setting?.positive_geo_target_type, 'PRESENCE'), `location option ${c.geo_target_type_setting?.positive_geo_target_type}`);
    expect(c.final_url_suffix === RSA_FINAL_URL_SUFFIX, 'tracking suffix differs');
    expect(Number(row?.campaign_budget?.amount_micros) === toMicros(settings.budget), `budget ${row?.campaign_budget?.amount_micros}`);
    for (const id of targets.locationIds) expect(criteria.some((r) => String(r.campaign_criterion?.location?.geo_target_constant ?? '').endsWith(`/${id}`)), `location ${id} missing`);
    for (const id of targets.languageIds) expect(criteria.some((r) => String(r.campaign_criterion?.language?.language_constant ?? '').endsWith(`/${id}`)), `language ${id} missing`);
    for (const label of targets.labels) expect(labelRows.some((r) => r.campaign_label?.label === label), `label ${label} missing`);
    if (problems.length > 0) throw new Error(`test campaign settings are wrong: ${problems.join('; ')}`);
    notes.push('test campaign read back: paused, Search only, Max Clicks CPC cap, budget, presence, locations, languages, labels, tracking suffix: all correct');
  } finally {
    await spend(db.app, cap, 2, 'preflight cleanup', db.runId);
    await ads.mutate([
      { entity: 'campaign', operation: 'remove', resource: campaignName },
      { entity: 'campaign_budget', operation: 'remove', resource: budgetName },
    ]);
    notes.push('test campaign removed');
  }
  return notes;
}

// Enum values come back as numbers or names depending on the library; accept both.
const ENUM_VALUES: Record<string, number> = {
  PAUSED: enums.CampaignStatus.PAUSED,
  SEARCH: enums.AdvertisingChannelType.SEARCH,
  PRESENCE: enums.PositiveGeoTargetType.PRESENCE,
};
function isEnum(value: unknown, name: string): boolean {
  return value === name || value === ENUM_VALUES[name];
}

// Takes over a campaign of this run that exists in Google Ads but not in our records (created just before a crash).
async function adoptCampaign(db: RunDb, ads: AdsPort, cap: number, name: string, campaignId: string): Promise<void> {
  const rows = await queryCounted(
    db,
    ads,
    cap,
    `SELECT ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.final_urls FROM ad_group_ad WHERE campaign.id = ${campaignId} AND ad_group_ad.status != 'REMOVED'`,
    'adopt campaign',
  );
  const byUrl = new Map<string, { adGroupId: string; adId: string }>();
  for (const r of rows) {
    const url = r.ad_group_ad?.ad?.final_urls?.[0];
    if (url) byUrl.set(url, { adGroupId: String(r.ad_group.id), adId: String(r.ad_group_ad.ad.id) });
  }
  const articles = await db.articlesOf(name);
  const found = articles.filter((a) => byUrl.has(a.url)).map((a) => ({ url: a.url, ...byUrl.get(a.url)! }));
  const missing = articles.filter((a) => !byUrl.has(a.url)).map((a) => ({ url: a.url, status: 'error' as const, error: 'not found in the existing campaign in Google Ads' }));
  await db.markCampaignUploaded(name, campaignId, found, missing);
  log(`run ${db.runId}: "${name}" already existed in Google Ads (id ${campaignId}); recorded ${found.length} ads, ${missing.length} not found`);
}

// Sorts Google's failures into rejected ads (by URL) and rejected keywords (as "<ad group>\u0000<keyword>").
// Undefined if anything else failed (campaign, budget, ad group) or Google gave no location.
function rejections(plan: CampaignPlan, error: AdsError): { ads: Map<string, string>; keywords: Map<string, string> } | undefined {
  if (error.failures.length === 0) return undefined;
  const ads = new Map<string, string>();
  const keywords = new Map<string, string>();
  for (const failure of error.failures) {
    const role = failure.index === undefined ? undefined : plan.roles[failure.index];
    const reason = `${failure.code}: ${failure.message}`.slice(0, 500);
    if (role?.kind === 'ad') ads.set(role.url, reason);
    else if (role?.kind === 'keyword') keywords.set(`${role.adGroup}\u0000${role.keyword}`, reason);
    else return undefined;
  }
  return { ads, keywords };
}

type LeftOut = { url: string; status: 'error' | 'skipped'; error: string };

// ---------- upload ----------
// Creates one campaign with all its ad groups, keywords and ads in a single atomic request.
// If Google rejects specific ads or keywords, they are left out and the rest is sent again. An article is
// left out only when its ad is rejected or none of its keywords is accepted. Everything left out is reported.
export async function uploadCampaign(db: RunDb, ads: AdsPort, settings: RunSettings, cap: number, targets: Targets, name: string, existing: Map<string, string>): Promise<void> {
  const existingId = existing.get(name);
  if (existingId) return adoptCampaign(db, ads, cap, name, existingId);

  const articles = await db.articlesOf(name);
  const leftOut: LeftOut[] = articles.filter((a) => a.copy_status !== 'done').map((a) => ({ url: a.url, status: 'skipped' as const, error: `no ad copy: ${a.copy_error ?? 'failed'}` }));
  let remaining = articles.filter((a) => a.copy_status === 'done');
  const rejectedKeywords = new Map<string, string>();

  for (let round = 0; round < 10; round++) {
    // Articles with no keyword left can't be advertised.
    const adsNow = adsFromArticles(remaining, new Set(rejectedKeywords.keys()));
    for (const ad of adsNow.filter((a) => a.keywords.length === 0)) {
      leftOut.push({ url: ad.url, status: 'error', error: `every keyword was rejected by Google: ${keywordNotes(ad.adGroup, remaining.find((a) => a.url === ad.url)!.keywords, rejectedKeywords)}` });
    }
    const sendable = adsNow.filter((a) => a.keywords.length > 0);
    remaining = remaining.filter((a) => sendable.some((s) => s.url === a.url));
    if (remaining.length === 0) {
      await db.markCampaignUploadedNothing(name, leftOut);
      log(`run ${db.runId}: "${name}" has no articles left to upload`);
      return;
    }
    const plan = campaignOperations(settings.account, name, sendable, settings, targets);
    await spend(db.app, cap, plan.operations.length, 'upload', db.runId, SYNC_RESERVE);
    try {
      const names = await ads.mutate(plan.operations);
      const campaignId = idFromResourceName(names[1]);
      const adGroupIds = new Map<string, string>();
      const uploaded: { url: string; adGroupId: string; adId: string; note: string | null }[] = [];
      plan.roles.forEach((role, i) => {
        if (role.kind === 'ad_group') adGroupIds.set(role.adGroup, idFromResourceName(names[i]));
        if (role.kind === 'ad') {
          // ad_group_ad resource name: customers/x/adGroupAds/{adGroupId}~{adId}
          const adId = idFromResourceName(names[i]).split('~')[1] ?? '';
          const article = remaining.find((a) => a.url === role.url)!;
          const note = keywordNotes(role.adGroup, article.keywords, rejectedKeywords);
          uploaded.push({ url: role.url, adGroupId: adGroupIds.get(role.adGroup) ?? '', adId, note: note ? `keyword(s) rejected by Google: ${note}` : null });
        }
      });
      await db.markCampaignUploaded(name, campaignId, uploaded, leftOut);
      log(`run ${db.runId}: "${name}" created (id ${campaignId}, ${uploaded.length} ads, ${leftOut.length} left out, ${rejectedKeywords.size} keywords rejected)`);
      return;
    } catch (error) {
      if (!(error instanceof AdsError)) throw error;
      if (isQuotaError(error)) throw await googleQuotaExhausted(db.app, error, plan.operations.length, db.runId);
      if (isRetryableError(error)) {
        await db.noteCampaignError(name, error.message.slice(0, 500));
        log(`run ${db.runId}: "${name}": temporary error, will try again: ${error.message.slice(0, 200)}`);
        return;
      }
      const bad = rejections(plan, error);
      if (!bad) {
        await db.markCampaignAttemptFailed(name, error.message.slice(0, 500), UPLOAD_MAX_ATTEMPTS);
        log(`run ${db.runId}: "${name}" failed: ${error.message.slice(0, 300)}`);
        return;
      }
      for (const [url, reason] of bad.ads) leftOut.push({ url, status: 'error', error: reason });
      for (const [key, reason] of bad.keywords) rejectedKeywords.set(key, reason);
      remaining = remaining.filter((a) => !bad.ads.has(a.url));
      log(`run ${db.runId}: "${name}": Google rejected ${bad.ads.size} ads and ${bad.keywords.size} keywords; sending again without them`);
    }
  }
  await db.markCampaignAttemptFailed(name, 'too many rejected ads', UPLOAD_MAX_ATTEMPTS);
}

// "<keyword> (<reason>)" for each of the article's keywords Google rejected in its ad group.
function keywordNotes(adGroup: string, keywords: string[], rejected: Map<string, string>): string {
  return [...new Set(keywords.map(keywordKey))]
    .filter((k) => rejected.has(`${adGroup}\u0000${k}`))
    .map((k) => `${k} (${rejected.get(`${adGroup}\u0000${k}`)})`)
    .join('; ')
    .slice(0, 800);
}

// ---------- top-up ----------
// Adds ads whose copy arrived after their campaign was uploaded (and their keywords, and any ad group
// that didn't exist yet) to the existing campaign. Rejected ads and keywords are left out and reported.
export async function topUpCampaign(db: RunDb, ads: AdsPort, settings: RunSettings, cap: number, name: string): Promise<void> {
  const campaign = await db.campaign(name);
  if (!campaign?.campaign_id) return;
  let remaining = (await db.articlesOf(name)).filter((a) => a.ad_status === 'skipped' && a.copy_status === 'done');
  if (remaining.length === 0) return;

  const groupRows = await queryCounted(db, ads, cap, `SELECT ad_group.id, ad_group.name FROM ad_group WHERE campaign.id = ${campaign.campaign_id} AND ad_group.status != 'REMOVED'`, 'top-up ad groups');
  const existingAdGroups = new Map(groupRows.map((r) => [String(r.ad_group.name), String(r.ad_group.id)]));
  const keywordRows = await queryCounted(
    db,
    ads,
    cap,
    `SELECT ad_group.name, ad_group_criterion.keyword.text FROM ad_group_criterion
     WHERE campaign.id = ${campaign.campaign_id} AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'`,
    'top-up keywords',
  );
  const existingKeywords = new Set(keywordRows.map((r) => `${r.ad_group.name}\u0000${keywordKey(String(r.ad_group_criterion?.keyword?.text ?? ''))}`));
  const leftOut: { url: string; error: string }[] = [];
  const rejectedKeywords = new Map<string, string>();

  for (let round = 0; round < 10 && remaining.length > 0; round++) {
    const adsNow = adsFromArticles(remaining, new Set(rejectedKeywords.keys()));
    // An article needs at least one keyword in its ad group: a new one, or one already there.
    const usable = adsNow.filter((a) => a.keywords.length > 0);
    for (const ad of adsNow.filter((a) => a.keywords.length === 0)) leftOut.push({ url: ad.url, error: 'every keyword was rejected by Google' });
    remaining = remaining.filter((a) => usable.some((u) => u.url === a.url));
    if (remaining.length === 0) break;
    const plan = topUpOperations(settings.account, campaign.campaign_id, usable, settings, existingAdGroups, existingKeywords);
    await spend(db.app, cap, plan.operations.length, 'top-up', db.runId, SYNC_RESERVE);
    try {
      const names = await ads.mutate(plan.operations);
      const added: { url: string; adGroupId: string; adId: string }[] = [];
      plan.roles.forEach((role, i) => {
        if (role.kind !== 'ad') return;
        const [adGroupId = '', adId = ''] = idFromResourceName(names[i]).split('~');
        added.push({ url: role.url, adGroupId, adId });
      });
      await db.markAdsAdded(added, leftOut);
      log(`run ${db.runId}: top-up "${name}": ${added.length} ads added, ${leftOut.length} left out`);
      return;
    } catch (error) {
      if (!(error instanceof AdsError)) throw error;
      if (isQuotaError(error)) throw await googleQuotaExhausted(db.app, error, plan.operations.length, db.runId);
      if (isRetryableError(error)) {
        log(`run ${db.runId}: top-up "${name}": temporary error, will try again: ${error.message.slice(0, 200)}`);
        return;
      }
      const bad = rejections(plan, error);
      if (!bad) {
        // Not an ad or keyword problem: these articles are reported instead of being tried forever.
        await db.markAdsAdded([], remaining.map((a) => ({ url: a.url, error: `could not be added to the existing campaign: ${error.message.slice(0, 400)}` })));
        log(`run ${db.runId}: top-up "${name}" failed: ${error.message.slice(0, 300)}`);
        return;
      }
      for (const [url, reason] of bad.ads) leftOut.push({ url, error: reason });
      for (const [key, reason] of bad.keywords) rejectedKeywords.set(key, reason);
      remaining = remaining.filter((a) => !bad.ads.has(a.url));
      log(`run ${db.runId}: top-up "${name}": Google rejected ${bad.ads.size} ads and ${bad.keywords.size} keywords; sending again without them`);
    }
  }
  if (leftOut.length > 0) await db.markAdsAdded([], leftOut);
}

// ---------- enable ----------
// Enables a wave's uploaded campaigns that are not enabled yet.
export async function enableWave(db: RunDb, ads: AdsPort, settings: RunSettings, cap: number, wave: Wave): Promise<number> {
  const cid = cleanCustomerId(settings.account);
  const toEnable = (await db.campaigns(wave)).filter((c) => c.status === 'uploaded' && !c.enabled_at && c.campaign_id);
  for (let i = 0; i < toEnable.length; i += 1000) {
    const chunk = toEnable.slice(i, i + 1000);
    await spend(db.app, cap, chunk.length, 'enable', db.runId);
    await ads.mutate(
      chunk.map((c) => ({
        entity: 'campaign',
        operation: 'update' as const,
        resource: { resource_name: `customers/${cid}/campaigns/${c.campaign_id}`, status: enums.CampaignStatus.ENABLED },
      })),
    );
    for (const c of chunk) await db.markEnabled(c.name);
  }
  if (toEnable.length > 0) log(`run ${db.runId}: ${toEnable.length} ${wave} campaigns enabled`);
  return toEnable.length;
}

// ---------- sync ----------
// Reads the status of the run's campaigns and Google's review result for each of its ads.
export async function sync(db: RunDb, ads: AdsPort, cap: number): Promise<void> {
  const ids = (await db.campaigns()).map((c) => c.campaign_id).filter((id): id is string => Boolean(id));
  let campaignCount = 0;
  let adCount = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const list = ids.slice(i, i + 500).join(', ');
    const campaigns = await queryCounted(db, ads, cap, `SELECT campaign.id, campaign.status, campaign.serving_status FROM campaign WHERE campaign.id IN (${list})`, 'sync campaigns');
    for (const r of campaigns) await db.setCampaignServing(String(r.campaign.id), `${statusName(r.campaign.status)} / ${servingName(r.campaign.serving_status)}`);
    const adsRows = await queryCounted(
      db,
      ads,
      cap,
      `SELECT ad_group_ad.ad.id, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status,
              ad_group_ad.policy_summary.policy_topic_entries
       FROM ad_group_ad WHERE campaign.id IN (${list}) AND ad_group_ad.status != 'REMOVED'`,
      'sync ads',
    );
    for (const r of adsRows) {
      const summary = r.ad_group_ad?.policy_summary ?? {};
      const topics = (summary.policy_topic_entries ?? []).map((t: any) => t.topic).filter(Boolean).join(', ');
      await db.setAdApproval(String(r.ad_group_ad.ad.id), `${approvalName(summary.approval_status)} (${reviewName(summary.review_status)})`, topics);
    }
    campaignCount += campaigns.length;
    adCount += adsRows.length;
  }
  await db.set('last_sync', new Date().toISOString());
  log(`run ${db.runId}: sync: ${campaignCount} campaigns, ${adCount} ads`);
}

const names = (table: Record<number | string, string | number>) => (v: unknown) => (typeof v === 'number' ? String(table[v] ?? v) : String(v ?? ''));
const statusName = names(enums.CampaignStatus as never);
const servingName = names(enums.CampaignServingStatus as never);
const approvalName = names(enums.PolicyApprovalStatus as never);
const reviewName = names(enums.PolicyReviewStatus as never);
