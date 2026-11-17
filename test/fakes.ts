import assert from 'node:assert/strict';
import { services } from 'google-ads-api';
import { AdsError, type AdsPort, type Operation } from '../src/ads.ts';
import type { BatchClient, BatchRequest, BatchResult } from '../src/copy.ts';
import { AppDb } from '../src/db.ts';

export const H = Array.from({ length: 15 }, (_, i) => `Headline Number ${i + 1}`);
export const D = Array.from({ length: 4 }, (_, i) => `Description number ${i + 1} for this article.`);

// A fresh database for each test, on the local Postgres (TEST_DATABASE_URL, default port 5433).
const ADMIN = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5433/postgres';
let counter = 0;
export async function freshDb(): Promise<AppDb> {
  const name = `cb_test_${process.pid}_${Date.now()}_${counter++}`;
  const admin = new AppDb(ADMIN);
  await admin.pool.query(`CREATE DATABASE ${name}`);
  await admin.close();
  const url = new URL(ADMIN);
  url.pathname = `/${name}`;
  const db = new AppDb(url.toString());
  await db.migrate();
  return db;
}

export class FakeBatches implements BatchClient {
  sent: BatchRequest[][] = [];
  themes = ['Chicken', 'Cakes', 'Other'];
  // Default answers: a theme list, a tag by keyword, complete ad copy.
  answer: (req: BatchRequest) => BatchResult = (req) => this.defaultAnswer(req);
  defaultAnswer(req: BatchRequest): BatchResult {
    if (req.custom_id === 'themes') return { custom_id: req.custom_id, type: 'succeeded', text: JSON.stringify({ themes: this.themes }) };
    if (req.custom_id.startsWith('t')) {
      const content = (req.params.messages as { content: string }[])[0].content;
      const keyword = content.match(/Search keywords: ([^,\n]*)/)![1].toLowerCase();
      const allowed = (req.params.output_config as any).format.schema.properties.theme.enum as string[];
      const theme = allowed.find((t) => keyword.includes(t.toLowerCase().replace(/s$/, ''))) ?? 'Other';
      return { custom_id: req.custom_id, type: 'succeeded', text: JSON.stringify({ theme, topic: keyword.split(' ').slice(0, 2).join(' ') }) };
    }
    return { custom_id: req.custom_id, type: 'succeeded', text: JSON.stringify({ descriptions: D, headlines: H }) };
  }
  async create(requests: BatchRequest[]) {
    this.sent.push(requests);
    return { id: `batch_${process.pid}_${this.sent.length}_${Math.random().toString(36).slice(2, 8)}` };
  }
  // Number of status checks a batch stays "running" before it ends (0 = ends at the first check).
  runningChecks = 0;
  private checks = new Map<string, number>();
  async status(id: string) {
    const seen = this.checks.get(id) ?? 0;
    this.checks.set(id, seen + 1);
    return { ended: seen >= this.runningChecks, counts: {} };
  }
  async *results(id: string) {
    const requests = this.sent[Number(id.split('_')[2]) - 1];
    for (const r of requests) yield this.answer(r);
  }
  ofKind(prefix: 'themes' | 't' | 'a'): BatchRequest[][] {
    return this.sent.filter((b) => (prefix === 'themes' ? b[0].custom_id === 'themes' : b[0].custom_id !== 'themes' && b[0].custom_id.startsWith(prefix)));
  }
}

interface FakeCampaign {
  id: string;
  resource: string;
  fields: Record<string, any>;
  budgetMicros: number;
  locations: string[];
  languages: string[];
  labels: string[];
  removed: boolean;
}

// An in-memory Google Ads account: stores what is created, answers the queries the app makes,
// and checks every operation is a valid Google Ads API message.
export class FakeAds implements AdsPort {
  calls: { operations: Operation[]; validateOnly: boolean }[] = [];
  queries: string[] = [];
  currency = 'INR';
  countries: Record<string, { id: string; name: string }> = { US: { id: '2840', name: 'United States' }, GB: { id: '2826', name: 'United Kingdom' }, CA: { id: '2124', name: 'Canada' } };
  languageList: Record<string, { id: string; name: string }> = { en: { id: '1000', name: 'English' }, es: { id: '1003', name: 'Spanish' } };
  labels = new Map<string, string>(); // name -> resource
  campaigns: FakeCampaign[] = [];
  budgets = new Map<string, number>();
  adGroups: { id: string; name: string; campaignId: string }[] = [];
  keywords: { adGroupId: string; text: string; matchType: number }[] = [];
  ads: { id: string; adGroupId: string; url: string; headlines: string[] }[] = [];
  failAdUrl: string | undefined; // Google rejects the ad with this final URL
  failKeyword: string | undefined; // Google rejects this keyword
  failNext: { kind: 'quota' | 'concurrent' | 'campaign'; times: number } | undefined; // the next N real mutates fail like this
  next = 100;

  addExistingCampaign(name: string): string {
    const id = String(this.next++);
    this.campaigns.push({ id, resource: `customers/1/campaigns/${id}`, fields: { name }, budgetMicros: 0, locations: [], languages: [], labels: [], removed: false });
    return id;
  }
  live(): FakeCampaign[] {
    return this.campaigns.filter((c) => !c.removed && !String(c.fields.name).startsWith('Campaign Builder preflight test'));
  }

  async mutate(operations: Operation[], options?: { validateOnly?: boolean }) {
    for (const op of operations) {
      const message = { [`${op.entity}_operation`]: { [op.operation]: op.resource } };
      const problem = services.MutateOperation.verify(message);
      assert.equal(problem, null, `${op.entity} ${op.operation}: ${problem}`);
    }
    this.calls.push({ operations, validateOnly: !!options?.validateOnly });
    if (this.failNext && this.failNext.times > 0 && !options?.validateOnly) {
      this.failNext.times--;
      if (this.failNext.kind === 'quota') throw new AdsError([{ index: undefined, message: 'Too many requests. Retry in 600 seconds.', code: 'quota_error.2' }], 'quota');
      if (this.failNext.kind === 'campaign') throw new AdsError([{ index: 1, message: 'Something is wrong with the campaign.', code: 'campaign_error.9' }], 'campaign');
      throw new AdsError([{ index: undefined, message: 'Multiple requests were attempting to modify the same resource at once. Retry the request.', code: 'database_error.2' }], 'db');
    }
    const failures = operations.flatMap((op, index) => {
      const r = op.resource as any;
      if (op.entity === 'ad_group_ad' && r.ad.final_urls[0] === this.failAdUrl) return [{ index, message: 'A policy was violated.', code: 'policy_violation_error.2' }];
      if (op.entity === 'ad_group_criterion' && r.keyword?.text === this.failKeyword) return [{ index, message: 'Keyword not allowed.', code: 'policy_violation_error.2' }];
      if (op.entity === 'campaign' && op.operation === 'create' && this.campaigns.some((c) => !c.removed && c.fields.name === r.name)) {
        return [{ index, message: 'Duplicate campaign name.', code: 'campaign_error.12' }];
      }
      return [];
    });
    if (failures.length > 0) throw new AdsError(failures, 'rejected');
    if (options?.validateOnly) return operations.map(() => '');

    const temp = new Map<string, string>();
    const real = (name: string) => temp.get(name) ?? name;
    return operations.map((op) => {
      if (op.operation === 'remove') {
        const name = op.resource as string;
        const campaign = this.campaigns.find((c) => c.resource === name);
        if (campaign) campaign.removed = true;
        this.budgets.delete(name);
        return name;
      }
      const r = op.resource as Record<string, any>;
      if (op.operation === 'update') {
        const campaign = this.campaigns.find((c) => c.id === String(r.resource_name).split('/').pop())!;
        Object.assign(campaign.fields, { ...r, resource_name: campaign.resource });
        return r.resource_name;
      }
      const id = String(this.next++);
      switch (op.entity) {
        case 'label': {
          const resource = `customers/1/labels/${id}`;
          this.labels.set(r.name, resource);
          return resource;
        }
        case 'campaign_budget': {
          const resource = `customers/1/campaignBudgets/${id}`;
          temp.set(r.resource_name, resource);
          this.budgets.set(resource, r.amount_micros);
          return resource;
        }
        case 'campaign': {
          const resource = `customers/1/campaigns/${id}`;
          temp.set(r.resource_name, resource);
          this.campaigns.push({ id, resource, fields: { ...r }, budgetMicros: this.budgets.get(real(r.campaign_budget)) ?? 0, locations: [], languages: [], labels: [], removed: false });
          return resource;
        }
        case 'campaign_criterion': {
          const campaign = this.campaigns.find((c) => c.resource === real(r.campaign))!;
          if (r.location) campaign.locations.push(r.location.geo_target_constant);
          if (r.language) campaign.languages.push(r.language.language_constant);
          return `customers/1/campaignCriteria/${campaign.id}~${id}`;
        }
        case 'campaign_label': {
          const campaign = this.campaigns.find((c) => c.resource === real(r.campaign))!;
          campaign.labels.push(r.label);
          return `customers/1/campaignLabels/${campaign.id}~${id}`;
        }
        case 'ad_group': {
          const resource = `customers/1/adGroups/${id}`;
          temp.set(r.resource_name, resource);
          this.adGroups.push({ id, name: r.name, campaignId: real(r.campaign).split('/').pop()! });
          return resource;
        }
        case 'ad_group_criterion': {
          const adGroupId = real(r.ad_group).split('/').pop()!;
          this.keywords.push({ adGroupId, text: r.keyword.text, matchType: r.keyword.match_type });
          return `customers/1/adGroupCriteria/${adGroupId}~${id}`;
        }
        case 'ad_group_ad': {
          const adGroupId = real(r.ad_group).split('/').pop()!;
          this.ads.push({ id, adGroupId, url: r.ad.final_urls[0], headlines: r.ad.responsive_search_ad.headlines.map((h: any) => h.text) });
          return `customers/1/adGroupAds/${adGroupId}~${id}`;
        }
        default:
          throw new Error(`fake: unknown entity ${op.entity}`);
      }
    });
  }

  async query(gaql: string): Promise<Record<string, any>[]> {
    this.queries.push(gaql);
    const quoted = [...gaql.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
    if (gaql.includes('FROM customer')) return [{ customer: { currency_code: this.currency, auto_tagging_enabled: true, descriptive_name: 'Test account' } }];
    if (gaql.includes('FROM geo_target_constant')) {
      return Object.entries(this.countries).filter(([code]) => quoted.includes(code)).map(([code, c]) => ({ geo_target_constant: { id: c.id, name: c.name, country_code: code } }));
    }
    if (gaql.includes('FROM language_constant')) {
      return Object.entries(this.languageList).filter(([code]) => quoted.includes(code)).map(([code, c]) => ({ language_constant: { id: c.id, name: c.name, code } }));
    }
    if (gaql.includes('FROM label')) return this.labels.has(quoted[0]) ? [{ label: { resource_name: this.labels.get(quoted[0]), name: quoted[0] } }] : [];
    if (gaql.includes('FROM campaign_criterion')) {
      const c = this.campaigns.find((x) => x.resource === quoted[0])!;
      return [...c.locations.map((l) => ({ campaign_criterion: { location: { geo_target_constant: l } } })), ...c.languages.map((l) => ({ campaign_criterion: { language: { language_constant: l } } }))];
    }
    if (gaql.includes('FROM campaign_label')) return this.campaigns.find((x) => x.resource === quoted[0])!.labels.map((label) => ({ campaign_label: { label } }));
    if (gaql.includes('FROM campaign WHERE campaign.resource_name')) {
      const c = this.campaigns.find((x) => x.resource === quoted[0])!;
      return [{ campaign: c.fields, campaign_budget: { amount_micros: c.budgetMicros } }];
    }
    if (gaql.startsWith('SELECT campaign.id, campaign.name FROM campaign')) return this.campaigns.filter((c) => !c.removed).map((c) => ({ campaign: { id: c.id, name: c.fields.name } }));
    const ids = (gaql.match(/campaign\.id IN \(([^)]*)\)/)?.[1] ?? gaql.match(/campaign\.id = (\d+)/)?.[1] ?? '').split(',').map((s) => s.trim());
    const groupIds = new Set(this.adGroups.filter((g) => ids.includes(g.campaignId)).map((g) => g.id));
    if (gaql.includes('FROM ad_group_criterion')) {
      return this.keywords.filter((k) => groupIds.has(k.adGroupId)).map((k) => ({ ad_group: { name: this.adGroups.find((g) => g.id === k.adGroupId)!.name }, ad_group_criterion: { keyword: { text: k.text } } }));
    }
    if (gaql.includes('policy_summary')) {
      return this.ads.filter((a) => groupIds.has(a.adGroupId)).map((a) => ({ ad_group_ad: { ad: { id: a.id }, policy_summary: { approval_status: 'APPROVED', review_status: 'REVIEWED', policy_topic_entries: [] } } }));
    }
    if (gaql.includes('FROM ad_group_ad')) return this.ads.filter((a) => groupIds.has(a.adGroupId)).map((a) => ({ ad_group: { id: a.adGroupId }, ad_group_ad: { ad: { id: a.id, final_urls: [a.url] } } }));
    if (gaql.includes('FROM ad_group WHERE')) return this.adGroups.filter((g) => ids.includes(g.campaignId)).map((g) => ({ ad_group: { id: g.id, name: g.name } }));
    if (gaql.includes('campaign.serving_status')) return this.campaigns.filter((c) => ids.includes(c.id)).map((c) => ({ campaign: { id: c.id, status: c.fields.status, serving_status: 2 } }));
    throw new Error(`fake: unexpected query ${gaql}`);
  }
}
