import { GoogleAdsApi, enums } from 'google-ads-api';
import type { ArticleRow } from './db.ts';
import { NETWORKS, RSA_FINAL_URL_SUFFIX } from './config.ts';
import type { RunSettings } from './settings.ts';

// From the rsa repo (src/ads.ts); campaign settings now come from the run.
// The parts of the Google Ads API the app uses (tests pass a fake).
export interface AdsPort {
  // One atomic request: everything is created, or nothing is. Returns the resource name of each operation, in order.
  mutate(operations: Operation[], options?: { validateOnly?: boolean }): Promise<string[]>;
  query(gaql: string): Promise<Record<string, any>[]>;
}

export interface Operation {
  entity: string;
  operation: 'create' | 'update' | 'remove';
  resource: Record<string, unknown> | string; // a remove takes just the resource name
}

export interface AdsFailure {
  index: number | undefined; // which operation in the request, when Google says
  message: string;
  code: string;
}

export class AdsError extends Error {
  readonly failures: AdsFailure[];
  constructor(failures: AdsFailure[], fallback: string) {
    super(failures.length > 0 ? failures.map((f) => `${f.code}: ${f.message}`).join(' | ') : fallback);
    this.failures = failures;
  }
}

// Google's daily operation limit for the developer token (shared with every tool on that token).
export function isQuotaError(error: AdsError): boolean {
  return error.failures.some((f) => f.code.startsWith('quota_error')) || /too many requests|RESOURCE_EXHAUSTED/i.test(error.message);
}

// Seconds Google says to wait ("Retry in 82374 seconds"); 1 hour if it doesn't say.
export function quotaRetrySeconds(error: AdsError): number {
  const match = error.message.match(/retry in (\d+) seconds/i);
  return match ? Number(match[1]) : 3600;
}

// Temporary errors that should just be tried again later (e.g. "Multiple requests were attempting to modify the same resource").
export function isRetryableError(error: AdsError): boolean {
  if (error.failures.length > 0 && error.failures.every((f) => /^(database_error|internal_error)/.test(f.code))) return true;
  return /retry the request|DEADLINE_EXCEEDED|UNAVAILABLE|ECONNRESET|ETIMEDOUT/i.test(error.message);
}

export function cleanCustomerId(id: string): string {
  return id.replace(/[^0-9]/g, '');
}

export const toMicros = (amount: number) => Math.round(amount * 1_000_000);

export interface GoogleAdsCredentials {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  loginCustomerId: string;
}

export function googleAdsPort(credentials: GoogleAdsCredentials, customerId: string): AdsPort {
  const client = new GoogleAdsApi({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    developer_token: credentials.developerToken,
  });
  const customer = client.Customer({
    customer_id: cleanCustomerId(customerId),
    login_customer_id: cleanCustomerId(credentials.loginCustomerId),
    refresh_token: credentials.refreshToken,
  });
  return {
    async mutate(operations, options) {
      try {
        const response = await customer.mutateResources(operations as never, { validate_only: options?.validateOnly ?? false, partial_failure: false });
        return (response.mutate_operation_responses ?? []).map(resourceNameOf);
      } catch (error) {
        throw toAdsError(error);
      }
    },
    async query(gaql) {
      try {
        return (await customer.query(gaql)) as Record<string, any>[];
      } catch (error) {
        throw toAdsError(error);
      }
    },
  };
}

function resourceNameOf(response: Record<string, any>): string {
  for (const value of Object.values(response ?? {})) {
    if (value && typeof value === 'object' && typeof value.resource_name === 'string') return value.resource_name;
  }
  return '';
}

export function toAdsError(error: unknown): AdsError {
  const raw = error as { errors?: any[]; message?: string };
  const failures: AdsFailure[] = [];
  for (const item of raw?.errors ?? []) {
    const elements: any[] = item?.location?.field_path_elements ?? [];
    const opElement = elements.find((e) => e?.field_name === 'mutate_operations');
    const code = item?.error_code ? Object.entries(item.error_code).map(([k, v]) => `${k}.${v}`).join(',') : 'UNKNOWN';
    let message = String(item?.message ?? 'unknown error');
    const policy = item?.details?.policy_finding_details?.policy_topic_entries;
    if (Array.isArray(policy) && policy.length > 0) message += ` [policy: ${policy.map((p: any) => p.topic).join(', ')}]`;
    failures.push({ index: typeof opElement?.index === 'number' ? opElement.index : undefined, message, code });
  }
  return new AdsError(failures, raw?.message ?? String(error));
}

export const idFromResourceName = (name: string) => name.split('/').pop() ?? '';

// ---------- what one campaign looks like ----------

// What each operation in the request is for, so a failure can be traced back to an article or a keyword.
export type OpRole =
  | { kind: 'campaign' }
  | { kind: 'ad_group'; adGroup: string }
  | { kind: 'keyword'; adGroup: string; keyword: string }
  | { kind: 'ad'; adGroup: string; url: string };

export interface CampaignPlan {
  operations: Operation[];
  roles: OpRole[];
}

export interface Ad {
  url: string;
  adGroup: string;
  keywords: string[];
  headlines: string[];
  descriptions: string[];
}

// What Google resolved for a run at preflight: label resource names and the location / language IDs.
export interface Targets {
  labels: string[];
  locationIds: string[];
  languageIds: string[];
}

export const keywordKey = (keyword: string) => keyword.toLowerCase().replace(/\s+/g, ' ').trim();

// `rejected` holds keywords Google refused, as "<ad group>\u0000<keyword>"; they are left out.
export function adsFromArticles(articles: ArticleRow[], rejected: Set<string> = new Set()): Ad[] {
  return articles.map((a) => ({
    url: a.url,
    adGroup: a.ad_group,
    keywords: [...new Set(a.keywords.map(keywordKey))].filter((k) => k && !rejected.has(`${a.ad_group}\u0000${k}`)),
    headlines: a.headlines ?? [],
    descriptions: a.descriptions ?? [],
  }));
}

export function campaignOperations(customerId: string, campaignName: string, ads: Ad[], settings: RunSettings, targets: Targets): CampaignPlan {
  const cid = cleanCustomerId(customerId);
  const budget = `customers/${cid}/campaignBudgets/-1`;
  const campaign = `customers/${cid}/campaigns/-2`;
  const operations: Operation[] = [];
  const roles: OpRole[] = [];
  const add = (op: Operation, role: OpRole) => {
    operations.push(op);
    roles.push(role);
  };

  add(
    {
      entity: 'campaign_budget',
      operation: 'create',
      resource: {
        resource_name: budget,
        name: `${campaignName} | budget`,
        amount_micros: toMicros(settings.budget),
        delivery_method: enums.BudgetDeliveryMethod.STANDARD,
        explicitly_shared: false,
      },
    },
    { kind: 'campaign' },
  );
  add(
    {
      entity: 'campaign',
      operation: 'create',
      resource: {
        resource_name: campaign,
        name: campaignName,
        status: enums.CampaignStatus.PAUSED,
        advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
        campaign_budget: budget,
        network_settings: NETWORKS,
        target_spend: { cpc_bid_ceiling_micros: toMicros(settings.maxCpc) },
        geo_target_type_setting: { positive_geo_target_type: enums.PositiveGeoTargetType.PRESENCE },
        contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
        final_url_suffix: RSA_FINAL_URL_SUFFIX,
        // Google's automatically created text assets switched off (as in the rsa and display pipelines).
        asset_automation_settings: [
          { asset_automation_type: enums.AssetAutomationType.TEXT_ASSET_AUTOMATION, asset_automation_status: enums.AssetAutomationStatus.OPTED_OUT },
        ],
      },
    },
    { kind: 'campaign' },
  );
  for (const id of targets.locationIds) {
    add({ entity: 'campaign_criterion', operation: 'create', resource: { campaign, location: { geo_target_constant: `geoTargetConstants/${id}` } } }, { kind: 'campaign' });
  }
  for (const id of targets.languageIds) {
    add({ entity: 'campaign_criterion', operation: 'create', resource: { campaign, language: { language_constant: `languageConstants/${id}` } } }, { kind: 'campaign' });
  }
  for (const label of targets.labels) add({ entity: 'campaign_label', operation: 'create', resource: { campaign, label } }, { kind: 'campaign' });

  appendAdGroups(cid, campaign, ads, settings, new Map(), new Set(), add);
  return { operations, roles };
}

// Ad groups, keywords and ads. An ad group already in Google Ads (by name, from `existing`) is reused;
// the others are created with temporary IDs. Keywords already in Google Ads (`existingKeywords`,
// as "<ad group>\u0000<keyword>") are not added again.
function appendAdGroups(
  cid: string,
  campaign: string,
  ads: Ad[],
  settings: RunSettings,
  existing: Map<string, string>,
  existingKeywords: Set<string>,
  add: (op: Operation, role: OpRole) => void,
): void {
  const adGroupNames = [...new Set(ads.map((ad) => ad.adGroup))];
  let temp = 3;
  for (const adGroupName of adGroupNames) {
    const existingId = existing.get(adGroupName);
    const adGroup = existingId ? `customers/${cid}/adGroups/${existingId}` : `customers/${cid}/adGroups/-${temp++}`;
    const groupAds = ads.filter((ad) => ad.adGroup === adGroupName);
    if (!existingId) {
      add(
        {
          entity: 'ad_group',
          operation: 'create',
          resource: { resource_name: adGroup, campaign, name: adGroupName, status: enums.AdGroupStatus.ENABLED, type: enums.AdGroupType.SEARCH_STANDARD },
        },
        { kind: 'ad_group', adGroup: adGroupName },
      );
    }
    // Every keyword of the ad group's articles, each added once.
    const keywords = [...new Set(groupAds.flatMap((ad) => ad.keywords))].filter((k) => !existingKeywords.has(`${adGroupName}\u0000${k}`));
    for (const keyword of keywords) {
      add(
        {
          entity: 'ad_group_criterion',
          operation: 'create',
          resource: { ad_group: adGroup, status: enums.AdGroupCriterionStatus.ENABLED, keyword: { text: keyword, match_type: enums.KeywordMatchType[settings.matchType] } },
        },
        { kind: 'keyword', adGroup: adGroupName, keyword },
      );
    }
    for (const ad of groupAds) {
      add(
        {
          entity: 'ad_group_ad',
          operation: 'create',
          resource: {
            ad_group: adGroup,
            status: enums.AdGroupAdStatus.ENABLED,
            ad: {
              final_urls: [ad.url],
              responsive_search_ad: {
                headlines: ad.headlines.map((text) => ({ text })),
                descriptions: ad.descriptions.map((text) => ({ text })),
              },
            },
          },
        },
        { kind: 'ad', adGroup: adGroupName, url: ad.url },
      );
    }
  }
}

// Adds ads (and their keywords, and any missing ad groups) to a campaign that already exists in Google Ads.
export function topUpOperations(customerId: string, campaignId: string, ads: Ad[], settings: RunSettings, existingAdGroups: Map<string, string>, existingKeywords: Set<string>): CampaignPlan {
  const cid = cleanCustomerId(customerId);
  const operations: Operation[] = [];
  const roles: OpRole[] = [];
  appendAdGroups(cid, `customers/${cid}/campaigns/${campaignId}`, ads, settings, existingAdGroups, existingKeywords, (op, role) => {
    operations.push(op);
    roles.push(role);
  });
  return { operations, roles };
}

// GAQL string literal
export const gaqlString = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
