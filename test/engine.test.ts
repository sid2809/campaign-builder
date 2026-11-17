import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { enums } from 'google-ads-api';
import { H, D, FakeAds, FakeBatches, freshDb } from './fakes.ts';
import { AppDb } from '../src/db.ts';
import { tickRun, tickAll, type Deps } from '../src/engine.ts';
import { readInput } from '../src/csv.ts';
import { reportRows } from '../src/report.ts';
import { DEFAULT_SETTINGS, type RunSettings } from '../src/settings.ts';
import { RSA_FINAL_URL_SUFFIX } from '../src/config.ts';

const open: AppDb[] = [];
after(async () => {
  for (const db of open) await db.close();
});

const SETTINGS: RunSettings = { ...DEFAULT_SETTINGS, account: '197-000-0000', labels: ['Test Label'], review: false };

// 30 articles: 14 chicken, 14 cake, 2 other. Each has two keywords.
function rows(n = 30): string {
  const lines = ['URL,Title,Keyword'];
  for (let i = 0; i < n; i++) {
    const kind = i >= 28 ? 'pasta' : i % 2 === 0 ? 'chicken' : 'cake';
    lines.push(`https://example.com/${kind}-${i}/,${kind} dish ${i},"${kind} recipe ${Math.floor(i / 6)} v${i}, easy ${kind} ${i}"`);
  }
  return lines.join('\n');
}

async function setup(overrides: Partial<RunSettings> = {}, csv = rows()) {
  const app = await freshDb();
  open.push(app);
  const batches = new FakeBatches();
  const ads = new FakeAds();
  const deps: Deps = { app, batches, adsFor: () => ads };
  const domainId = await app.createDomain('example.com', DEFAULT_SETTINGS);
  const input = readInput(csv);
  assert.deepEqual(input.problems, []);
  const runId = await app.createRun(domainId, 'Test run', { ...SETTINGS, ...overrides }, input.articles, input.skipped);
  const db = app.forRun(runId);
  const ticks = async (n: number) => {
    for (let i = 0; i < n; i++) await tickRun(deps, runId);
  };
  return { app, batches, ads, deps, runId, db, ticks, domainId };
}

test('no review, no pilot: every campaign is created paused with the run\'s settings; nothing is enabled until asked', async () => {
  const { ads, db, ticks } = await setup({ countries: ['US', 'GB'], languages: ['en', 'es'], labels: ['Label A', 'Label B'], matchType: 'EXACT', maxCpc: 4.5, budget: 1500 });
  await ticks(6);
  const campaigns = await db.campaigns();
  assert.ok(campaigns.length > 0 && campaigns.every((c) => c.status === 'uploaded' && c.campaign_id), JSON.stringify(campaigns.map((c) => [c.name, c.status, c.error])));
  const live = ads.live();
  assert.equal(live.length, campaigns.length);
  for (const c of live) {
    assert.equal(c.fields.status, enums.CampaignStatus.PAUSED);
    assert.equal(c.fields.advertising_channel_type, enums.AdvertisingChannelType.SEARCH);
    assert.deepEqual(c.fields.network_settings, { target_google_search: true, target_search_network: false, target_partner_search_network: false, target_content_network: false });
    assert.equal(c.fields.target_spend.cpc_bid_ceiling_micros, 4_500_000);
    assert.equal(c.budgetMicros, 1_500_000_000);
    assert.equal(c.fields.geo_target_type_setting.positive_geo_target_type, enums.PositiveGeoTargetType.PRESENCE);
    assert.equal(c.fields.final_url_suffix, RSA_FINAL_URL_SUFFIX);
    assert.deepEqual(c.locations.sort(), ['geoTargetConstants/2826', 'geoTargetConstants/2840']);
    assert.deepEqual(c.languages.sort(), ['languageConstants/1000', 'languageConstants/1003']);
    assert.deepEqual(c.labels.sort(), [ads.labels.get('Label A'), ads.labels.get('Label B')].sort());
  }
  // The preflight test campaign was created and removed.
  assert.equal(ads.campaigns.filter((c) => String(c.fields.name).startsWith('Campaign Builder preflight test')).length, 1);
  assert.ok(ads.campaigns.filter((c) => String(c.fields.name).startsWith('Campaign Builder preflight test')).every((c) => c.removed));
  // Every article has an ad; every keyword of every article is in its ad group, exact match, once.
  const articles = await db.allArticles();
  assert.equal(ads.ads.length, 30);
  assert.ok(articles.every((a) => a.ad_status === 'uploaded' && a.ad_id));
  assert.ok(ads.keywords.every((k) => k.matchType === enums.KeywordMatchType.EXACT));
  for (const a of articles) {
    const texts = ads.keywords.filter((k) => k.adGroupId === a.ad_group_id).map((k) => k.text);
    for (const k of a.keywords) assert.ok(texts.includes(k.toLowerCase()), `${k} missing`);
    assert.equal(new Set(texts).size, texts.length);
  }
  // At most 3 ads per ad group, at most 4 ad groups per campaign, one theme per campaign.
  const perGroup = new Map<string, number>();
  for (const a of ads.ads) perGroup.set(a.adGroupId, (perGroup.get(a.adGroupId) ?? 0) + 1);
  assert.ok([...perGroup.values()].every((n) => n <= 3));
  for (const c of live) assert.ok(ads.adGroups.filter((g) => g.campaignId === c.id).length <= 4);
  for (const c of campaigns) assert.equal(new Set((await db.articlesOf(c.name)).map((a) => a.theme)).size, 1);
  // Not enabled until the button.
  assert.ok(campaigns.every((c) => !c.enabled_at));
  assert.match((await db.run()).status, /Uploaded \(paused\)/);
  await db.set('enable_rest', 'requested');
  await ticks(1);
  assert.ok(ads.live().every((c) => c.fields.status === enums.CampaignStatus.ENABLED));
  assert.match((await db.run()).status, /Uploaded and enabled/);
  // Sync wrote Google's review result.
  assert.ok((await db.allArticles()).every((a) => a.approval === 'APPROVED (REVIEWED)'));
});

test('review on: stops for theme confirmation and for Approve; nothing reaches Google before Approve', async () => {
  const { ads, batches, db, ticks } = await setup({ review: true });
  await ticks(4);
  let run = await db.run();
  assert.equal(run.waiting, 'themes');
  assert.deepEqual(JSON.parse((await db.get('themes_proposed'))!), ['Chicken', 'Cakes', 'Other']);
  assert.equal(batches.ofKind('t').length, 0, 'no tagging before the themes are confirmed');
  assert.equal(ads.calls.length + ads.queries.length, 0);
  // The user removes "Cakes" from the list: cake articles can only be tagged "Other".
  await db.set('themes', JSON.stringify(['Chicken', 'Other']));
  await ticks(4);
  run = await db.run();
  assert.equal(run.waiting, 'approve');
  assert.deepEqual([...new Set((await db.allArticles()).map((a) => a.theme))].sort(), ['Chicken', 'Other']);
  assert.ok((await db.allArticles()).every((a) => a.copy_status === 'done'), 'copy is ready for the review');
  assert.equal(ads.calls.length + ads.queries.length, 0, 'nothing sent to Google before Approve');
  await ticks(3);
  assert.equal(ads.calls.length, 0);
  await db.set('approved', '1');
  await ticks(2);
  assert.ok((await db.campaigns()).every((c) => c.status === 'uploaded'));
  assert.equal((await db.run()).waiting, null);
});

test('pilot: the set number of campaigns goes first, spread over themes; the rest waits for "Upload rest"', async () => {
  const { ads, db, ticks } = await setup({ pilot: 2 });
  await ticks(6);
  const pilot = await db.campaigns('pilot');
  const rest = await db.campaigns('rest');
  assert.equal(pilot.length, 2);
  assert.equal(new Set(pilot.map((c) => c.name.split(' | ')[0])).size, 2, 'two themes in the pilot');
  assert.ok(pilot.every((c) => c.status === 'uploaded') && rest.length > 0 && rest.every((c) => c.status === 'pending'));
  assert.equal(ads.live().length, 2);
  assert.match((await db.run()).status, /Pilot uploaded/);
  await ticks(3);
  assert.equal(ads.live().length, 2, 'the rest is not uploaded without the button');
  await db.set('enable_pilot', 'requested');
  await ticks(1);
  assert.equal(ads.live().filter((c) => c.fields.status === enums.CampaignStatus.ENABLED).length, 2);
  await db.set('upload_rest', '1');
  await ticks(2);
  assert.ok((await db.campaigns()).every((c) => c.status === 'uploaded'));
  assert.equal(ads.live().filter((c) => c.fields.status === enums.CampaignStatus.PAUSED).length, rest.length);
});

test('an ad Google rejects is left out and reported; a rejected keyword is left out and noted; nothing is dropped silently', async () => {
  const { ads, db, ticks } = await setup();
  ads.failAdUrl = 'https://example.com/chicken-0/';
  ads.failKeyword = 'easy cake 1';
  await ticks(6);
  const rejected = (await db.article('https://example.com/chicken-0/'))!;
  assert.equal(rejected.ad_status, 'error');
  assert.match(rejected.error ?? '', /policy_violation_error/);
  const noted = (await db.article('https://example.com/cake-1/'))!;
  assert.equal(noted.ad_status, 'uploaded');
  assert.match(noted.error ?? '', /keyword\(s\) rejected by Google: easy cake 1/);
  assert.ok(!ads.keywords.some((k) => k.text === 'easy cake 1'));
  assert.equal(ads.ads.length, 29);
  const report = await reportRows(db);
  assert.equal(report.length - 1, 30);
  const byUrl = new Map(report.slice(1).map((r) => [r[1], r]));
  assert.equal(byUrl.get('https://example.com/chicken-0/')![4], 'Not created: rejected');
  assert.equal(byUrl.get('https://example.com/cake-1/')![4], 'Created (with a note)');
  assert.equal(report.slice(1).filter((r) => r[4] === 'Created').length, 28);
});

test('an article whose every keyword is rejected is left out with the reason', async () => {
  const { ads, db, ticks } = await setup({}, 'URL,Title,Keyword\nhttps://example.com/a/,Chicken a,bad word\nhttps://example.com/b/,Chicken b,chicken b');
  ads.failKeyword = 'bad word';
  await ticks(6);
  assert.match((await db.article('https://example.com/a/'))!.error ?? '', /every keyword was rejected by Google: bad word/);
  assert.equal((await db.article('https://example.com/b/'))!.ad_status, 'uploaded');
});

test('a campaign name already in the account stops the run before anything is created', async () => {
  const { ads, db, ticks } = await setup();
  ads.addExistingCampaign('Chicken | 0003');
  await ticks(6);
  assert.equal(await db.get('preflight'), 'failed');
  assert.match((await db.run()).status, /Stopped: preflight failed: 1 campaign names of this run already exist/);
  assert.equal(ads.live().length, 1, 'only the campaign that was there before');
  assert.ok(!ads.calls.some((c) => !c.validateOnly && c.operations.some((o) => o.entity === 'campaign')));
});

test('account not in INR: preflight stops the run', async () => {
  const { ads, db, ticks } = await setup();
  ads.currency = 'USD';
  await ticks(6);
  assert.match((await db.get('preflight_notes')) ?? '', /currency is USD/);
  assert.equal(ads.live().length, 0);
});

test('unknown country code: preflight stops the run', async () => {
  const { ads, db, ticks } = await setup({ countries: ['US', 'ZZ'] });
  await ticks(6);
  assert.match((await db.get('preflight_notes')) ?? '', /country "ZZ": Google returned 0/);
  assert.equal(ads.live().length, 0);
});

test('Google quota error: the run waits, no try is used, the refused call is not counted; it carries on after the wait', async () => {
  const { app, ads, db, ticks } = await setup();
  await ticks(2); // copy done, tags sent; the next tick groups, runs the preflight and uploads
  ads.failNext = { kind: 'quota', times: 1 };
  await ticks(1);
  assert.match((await db.run()).status, /Google's daily API limit/);
  const until = await app.getSetting('google_quota_until');
  assert.ok(until && Date.parse(until) > Date.now());
  assert.ok((await db.campaigns()).every((c) => c.attempts === 0));
  const before = ads.calls.length;
  await ticks(2);
  assert.equal(ads.calls.length, before, 'no call while waiting');
  await app.setSetting('google_quota_until', new Date(Date.now() - 1000).toISOString());
  await ticks(3);
  assert.ok((await db.campaigns()).every((c) => c.status === 'uploaded'));
});

test('temporary "modify the same resource" error: no try used, the campaign is created on a later pass', async () => {
  const { ads, db, ticks } = await setup();
  await ticks(2);
  // The preflight's test campaign and its clean-up go through; the uploads after it hit the error 3 times.
  let seen = 0;
  const original = ads.mutate.bind(ads);
  ads.mutate = async (operations, options) => {
    const isUpload = !options?.validateOnly && operations.some((o) => o.entity === 'ad_group_ad');
    if (isUpload && seen++ < 3) ads.failNext = { kind: 'concurrent', times: 1 };
    return original(operations, options);
  };
  await ticks(4);
  const campaigns = await db.campaigns();
  assert.ok(campaigns.every((c) => c.status === 'uploaded' && c.attempts === 0), JSON.stringify(campaigns.map((c) => [c.status, c.attempts])));
  assert.equal(ads.live().length, campaigns.length);
});

test('a campaign that keeps failing is tried 3 times, then reported; the others are created', async () => {
  const { ads, db, ticks } = await setup();
  await ticks(2);
  // The preflight test campaign must succeed first, so fail only real campaigns.
  const original = ads.mutate.bind(ads);
  let target: string | undefined;
  ads.mutate = async (operations, options) => {
    const campaign = operations.find((o) => o.entity === 'campaign' && o.operation === 'create');
    const name = (campaign?.resource as any)?.name as string | undefined;
    if (!options?.validateOnly && name && !name.startsWith('Campaign Builder')) {
      target ??= name;
      if (name === target) {
        ads.failNext = { kind: 'campaign', times: 1 };
      }
    }
    return original(operations, options);
  };
  await ticks(5);
  const failed = (await db.campaigns()).filter((c) => c.status === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].attempts, 3);
  const report = await reportRows(db);
  const bad = report.slice(1).filter((r) => r[6] === failed[0].name);
  assert.ok(bad.length > 0 && bad.every((r) => r[4] === 'Not created: rejected' && /campaign not created/.test(String(r[5]))));
  assert.match((await db.run()).status, /1 not created/);
});

test('ad copy: a cut-off answer still gives an ad; an answer that never works is reported as "no ad copy"', async () => {
  const { batches, db, ticks } = await setup();
  const many = Array.from({ length: 40 }, (_, i) => `Headline Number ${i + 1}`);
  const full = JSON.stringify({ descriptions: D, headlines: many });
  batches.answer = (req) => {
    if (req.custom_id === 'a0') return { custom_id: req.custom_id, type: 'succeeded', text: full.slice(0, full.indexOf('Headline Number 30') + 8), stopReason: 'max_tokens' };
    if (req.custom_id === 'a1') return { custom_id: req.custom_id, type: 'succeeded', text: 'Sorry, I cannot.', stopReason: 'end_turn' };
    return batches.defaultAnswer(req);
  };
  await ticks(8);
  const cut = (await db.articleByIndex(0))!;
  assert.equal(cut.copy_status, 'done');
  assert.equal(cut.headlines!.length, 15);
  assert.equal(cut.ad_status, 'uploaded');
  const never = (await db.articleByIndex(1))!;
  assert.equal(never.copy_status, 'failed');
  assert.equal(never.copy_attempts, 3);
  assert.equal(never.ad_status, 'skipped');
  const line = (await reportRows(db)).find((r) => r[1] === never.url)!;
  assert.equal(line[4], 'Not created: no ad copy');
  assert.match(String(line[5]), /not valid JSON \(stop_reason end_turn\): Sorry, I cannot/);
  assert.equal(batches.ofKind('a').length, 3, 'first batch and two retries');
});

test('default copy rules: the prompt carries them and clickbait lines are dropped; a run\'s own rules replace them', async () => {
  const withDefault = await setup();
  withDefault.batches.answer = (req) =>
    req.custom_id.startsWith('a') ? { custom_id: req.custom_id, type: 'succeeded', text: JSON.stringify({ descriptions: D, headlines: [...H.slice(0, 14), 'The Hidden Secret Revealed'] }) } : withDefault.batches.defaultAnswer(req);
  await withDefault.ticks(2);
  const system = String(withDefault.batches.ofKind('a')[0][0].params.system);
  assert.match(system, /No clickbait or sensational wording/);
  assert.match(system, /"Best" and "2026"/);
  assert.match(system, /Write the descriptions first/);
  const kept = (await withDefault.db.articleByIndex(0))!;
  assert.equal(kept.headlines!.length, 14, 'the banned line was dropped');
  assert.ok(!kept.headlines!.includes('The Hidden Secret Revealed'));
  assert.equal(kept.copy_status, 'pending', 'incomplete, so it is asked again');

  const own = await setup({ copyRules: 'Always mention free shipping.\nUse a friendly tone.' });
  own.batches.answer = withDefault.batches.answer;
  await own.ticks(2);
  const ownSystem = String(own.batches.ofKind('a')[0][0].params.system);
  assert.match(ownSystem, /- Always mention free shipping\.\n- Use a friendly tone\./);
  assert.doesNotMatch(ownSystem, /clickbait/);
  assert.match(ownSystem, /at most 30 characters/);
  assert.equal((await own.db.articleByIndex(0))!.headlines!.length, 15, 'the banned-word filter belongs to the default rules only');
});

test('a campaign created in Google just before a crash is taken over, not created twice', async () => {
  const { ads, db, ticks } = await setup();
  await ticks(2);
  // The first campaign is created in Google, but the record of it is lost.
  const originalMark = db.markCampaignUploaded.bind(db);
  const { RunDb } = await import('../src/db.ts');
  let crashed = false;
  const proto = RunDb.prototype.markCampaignUploaded;
  RunDb.prototype.markCampaignUploaded = async function (...args) {
    if (!crashed) {
      crashed = true;
      throw new Error('crash');
    }
    return proto.apply(this, args);
  };
  try {
    await assert.rejects(ticks(1), /crash/);
    await ticks(2);
  } finally {
    RunDb.prototype.markCampaignUploaded = proto;
  }
  void originalMark;
  const campaigns = await db.campaigns();
  assert.ok(campaigns.every((c) => c.status === 'uploaded'));
  const names = ads.live().map((c) => c.fields.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.length, campaigns.length);
  assert.ok((await db.allArticles()).every((a) => a.ad_status === 'uploaded' && a.ad_id));
});

test('late ad copy: the ad goes into its existing campaign and ad group; keywords already there are not added twice', async () => {
  const { ads, batches, db, ticks } = await setup();
  let late = true;
  batches.answer = (req) => (late && req.custom_id === 'a0' ? { custom_id: req.custom_id, type: 'errored', error: 'overloaded' } : batches.defaultAnswer(req));
  await ticks(8);
  const article = (await db.articleByIndex(0))!;
  assert.equal(article.ad_status, 'skipped');
  const campaignsBefore = ads.live().length;
  const groupsBefore = ads.adGroups.length;
  // The copy arrives later (as with the one-time retry in the rsa repo).
  late = false;
  await db.app.pool.query("UPDATE articles SET copy_status = 'pending', copy_attempts = 0, copy_error = NULL WHERE run_id = $1 AND row_index = 0", [db.runId]);
  await ticks(3);
  const after = (await db.articleByIndex(0))!;
  assert.equal(after.ad_status, 'uploaded');
  assert.equal(ads.live().length, campaignsBefore);
  assert.ok(ads.adGroups.length <= groupsBefore + 1);
  const texts = ads.keywords.filter((k) => k.adGroupId === after.ad_group_id).map((k) => k.text);
  assert.equal(new Set(texts).size, texts.length, 'no keyword twice in the ad group');
  for (const k of after.keywords) assert.ok(texts.includes(k.toLowerCase()));
});

test('numbering: "continue" carries on after the domain\'s last number; "restart" begins at 0001', async () => {
  const first = await setup({ numbering: 'continue' });
  await first.ticks(4);
  const firstNames = (await first.db.campaigns()).map((c) => c.name);
  assert.match(firstNames[0], /\| 0001$/);
  const input = readInput(rows());
  const secondId = await first.app.createRun(first.domainId, 'Second', { ...SETTINGS, numbering: 'continue' }, input.articles, []);
  for (let i = 0; i < 4; i++) await tickRun(first.deps, secondId);
  const secondNames = (await first.app.forRun(secondId).campaigns()).map((c) => c.name);
  assert.equal(Number(secondNames[0].split(' | ')[1]), firstNames.length + 1);
  assert.equal(new Set([...firstNames, ...secondNames]).size, firstNames.length + secondNames.length);
  const thirdId = await first.app.createRun(first.domainId, 'Third', { ...SETTINGS, numbering: 'restart', namePattern: 'X {theme} #{number}' }, input.articles, []);
  for (let i = 0; i < 4; i++) await tickRun(first.deps, thirdId);
  assert.match((await first.app.forRun(thirdId).campaigns())[0].name, /^X .* #0001$/);
});

test('the daily cap is shared by every run and stops uploads; they continue when it is raised', async () => {
  const { app, ads, db, deps, ticks, domainId } = await setup();
  const input = readInput(rows());
  const otherId = await app.createRun(domainId, 'Other', { ...SETTINGS, namePattern: 'B {theme} | {number}' }, input.articles, []);
  await app.setSetting('daily_cap', '150');
  for (let i = 0; i < 6; i++) await tickAll(deps);
  const used = await app.opsLast24h();
  assert.ok(used <= 150, `used ${used}`);
  const all = [...(await db.campaigns()), ...(await app.forRun(otherId).campaigns())];
  assert.ok(all.some((c) => c.status === 'pending'));
  assert.match((await db.run()).status + (await app.forRun(otherId).run()).status, /daily API cap 150 reached/);
  await app.setSetting('daily_cap', '14000');
  for (let i = 0; i < 3; i++) await tickAll(deps);
  const done = [...(await db.campaigns()), ...(await app.forRun(otherId).campaigns())];
  assert.ok(done.every((c) => c.status === 'uploaded'));
  assert.equal(ads.live().length, done.length);
  void ticks;
});

test('one run\'s error does not stop another run', async () => {
  const { app, deps, db, domainId } = await setup({ countries: ['ZZ'] });
  const otherId = await app.createRun(domainId, 'Good', { ...SETTINGS, namePattern: 'G {theme} | {number}' }, readInput(rows()).articles, []);
  for (let i = 0; i < 6; i++) await tickAll(deps);
  assert.equal(await db.get('preflight'), 'failed');
  assert.ok((await app.forRun(otherId).campaigns()).every((c) => c.status === 'uploaded'));
});

test('a batch still running is waited for, never sent twice (tags and copy)', async () => {
  const { batches, db, ticks } = await setup();
  batches.runningChecks = 2;
  await ticks(12);
  assert.equal(batches.ofKind('themes').length, 1);
  assert.equal(batches.ofKind('t').length, 1);
  assert.equal(batches.ofKind('a').length, 1);
  assert.ok((await db.allArticles()).every((a) => a.theme && a.copy_status === 'done'));
  assert.deepEqual([...new Set((await db.allArticles()).map((a) => a.theme))].sort(), ['Cakes', 'Chicken', 'Other']);
});

test('the report has one line per row of the file, including rows that could not become an ad', async () => {
  const csv = ['URL,Title,Keyword', 'https://example.com/chicken-a/,Chicken a,chicken a', 'https://example.com/chicken-a/,Chicken again,chicken again', ',No url,x', 'https://example.com/b/,,cake b', 'https://example.com/c/,Cake c,', 'ftp://example.com/d,Cake d,cake d', '', 'https://example.com/cake-e/,Cake e,"cake e, cake e2"'].join('\n');
  const { db, ticks } = await setup({}, csv);
  await ticks(6);
  const report = await reportRows(db);
  assert.deepEqual(report.slice(1).map((r) => [r[0], r[4], r[5]]), [
    [2, 'Created', ''],
    [3, 'Not created', 'same URL as row 2 (one ad per URL)'],
    [4, 'Not created', 'missing URL'],
    [5, 'Not created', 'missing title'],
    [6, 'Not created', 'missing keyword'],
    [7, 'Not created', 'the URL is not a web address (http or https)'],
    [9, 'Created', ''],
  ]);
});

test('late ad copy for an article that shares a keyword with an ad already in its ad group: the keyword is not added again', async () => {
  const csv = 'URL,Title,Keyword\nhttps://example.com/a/,Chicken a,"chicken soup, soup a"\nhttps://example.com/b/,Chicken b,"chicken soup, soup b"';
  const { ads, batches, db, ticks } = await setup({}, csv);
  let late = true;
  batches.answer = (req) => (late && req.custom_id === 'a1' ? { custom_id: req.custom_id, type: 'errored', error: 'overloaded' } : batches.defaultAnswer(req));
  await ticks(8);
  assert.equal((await db.articleByIndex(1))!.ad_status, 'skipped');
  late = false;
  await db.app.pool.query("UPDATE articles SET copy_status = 'pending', copy_attempts = 0, copy_error = NULL WHERE run_id = $1 AND row_index = 1", [db.runId]);
  await ticks(3);
  const b = (await db.articleByIndex(1))!;
  assert.equal(b.ad_status, 'uploaded');
  const texts = ads.keywords.filter((k) => k.adGroupId === b.ad_group_id).map((k) => k.text).sort();
  assert.deepEqual(texts, ['chicken soup', 'soup a', 'soup b']);
});
