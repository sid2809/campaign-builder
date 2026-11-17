import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { FakeAds, FakeBatches, freshDb } from './fakes.ts';
import { createWeb } from '../src/web.ts';
import { tickAll, type Deps } from '../src/engine.ts';
import { parseCsv, readInput, toCsv } from '../src/csv.ts';
import { parseSettings, settingsToForm, DEFAULT_SETTINGS } from '../src/settings.ts';
import type { AppDb } from '../src/db.ts';

const PASSWORD = 'correct horse battery';
const servers: Server[] = [];
const dbs: AppDb[] = [];
after(async () => {
  for (const s of servers) s.close();
  for (const d of dbs) await d.close();
});

async function start() {
  const app = await freshDb();
  dbs.push(app);
  const server = createWeb(app, { password: PASSWORD });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  const get = (path: string) => fetch(base + path, { headers: { cookie }, redirect: 'manual' });
  const post = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form), redirect: 'manual' });
  const login = async () => {
    const r = await post('/login', { password: PASSWORD });
    assert.equal(r.status, 303);
    cookie = r.headers.get('set-cookie')!.split(';')[0];
  };
  const batches = new FakeBatches();
  const ads = new FakeAds();
  const deps: Deps = { app, batches, adsFor: () => ads };
  const ticks = async (n: number) => {
    for (let i = 0; i < n; i++) await tickAll(deps);
  };
  return { app, base, get, post, login, batches, ads, ticks };
}

const RUN_FORM = { ...settingsToForm({ ...DEFAULT_SETTINGS, account: '197-000-0000', labels: ['Ponly Test'], pilot: 1 }), name: 'First run' };
const CSV = ['URL,Title,Keyword', 'https://example.com/chicken-1/,Chicken one,"chicken soup, best chicken soup"', 'https://example.com/chicken-2/,Chicken two,chicken roast', 'https://example.com/cake-1/,Cake one,cake lemon', 'https://example.com/cake-1/,Cake again,cake again', 'https://example.com/x/,,no title'].join('\n');

test('every page needs the password; a wrong password does not sign in', async () => {
  const { get, post, base } = await start();
  for (const path of ['/', '/domains', '/runs/new', '/runs/1', '/runs/1/report.csv']) {
    const r = await get(path);
    assert.equal(r.status, 303, path);
    assert.equal(r.headers.get('location'), '/login');
  }
  const wrong = await post('/login', { password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);
  const forged = await fetch(base + '/', { headers: { cookie: 'cb=99999999999999.deadbeef' }, redirect: 'manual' });
  assert.equal(forged.status, 303);
  assert.equal((await post('/runs/1/action', { action: 'approve' })).status, 303);
});

test('a form posted from another site is refused', async () => {
  const { post, login } = await start();
  await login();
  const r = await post('/settings/cap', { cap: '5000' }, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('full flow through the dashboard: domain, run with review and pilot, confirm themes, approve, enable, report', async () => {
  const { app, get, post, login, ads, ticks } = await start();
  await login();

  // Domain with defaults.
  const bad = await post('/domains/new', { ...settingsToForm(DEFAULT_SETTINGS), name: '', countries: 'USA' });
  assert.equal(bad.status, 400);
  const badText = await bad.text();
  assert.match(badText, /Domain name: required/);
  assert.match(badText, /Country &quot;USA&quot; is not a 2-letter code/);
  assert.equal((await post('/domains/new', { ...settingsToForm({ ...DEFAULT_SETTINGS, account: '197-000-0000', labels: ['Ponly Test'] }), name: 'example.com' })).status, 303);
  const [domain] = await app.domains();
  assert.equal(domain.defaults.account, '197-000-0000');

  // New run: the form is pre-filled from the domain, but "review" must be answered.
  const form = await (await get(`/runs/new?domain=${domain.id}`)).text();
  assert.match(form, /value="197-000-0000"/);
  assert.doesNotMatch(form, /name="review" value="(yes|no)" checked/);
  const noReview = await post('/runs/new', { ...RUN_FORM, review: '', domain_id: String(domain.id), csv: CSV, step: 'start' });
  assert.equal(noReview.status, 400);
  assert.match(await noReview.text(), /Review before publishing: choose yes or no/);
  assert.equal((await app.runs()).length, 0);

  // Check the file: summary with the rows that can't become an ad; nothing is created yet.
  const check = await post('/runs/new', { ...RUN_FORM, review: 'yes', domain_id: String(domain.id), csv: CSV, step: 'check' });
  const checkText = await check.text();
  assert.equal(check.status, 200);
  assert.match(checkText, /<b>3<\/b> articles will become ads/);
  assert.match(checkText, /2 rows can't become an ad/);
  assert.match(checkText, /same URL as row 4/);
  assert.match(checkText, /missing title/);
  assert.equal((await app.runs()).length, 0);

  const started = await post('/runs/new', { ...RUN_FORM, review: 'yes', domain_id: String(domain.id), csv: CSV, step: 'start' });
  assert.equal(started.status, 303);
  const runPath = started.headers.get('location')!;
  const [run] = await app.runs();
  assert.equal(run.settings.pilot, 1);
  assert.equal(run.settings.review, true);

  // Waits for the themes.
  await ticks(3);
  assert.match(await (await get(runPath)).text(), /Confirm the themes/);
  const themesPage = await (await get(`${runPath}/review`)).text();
  assert.match(themesPage, /Chicken\nCakes<\/textarea>/);
  // A button that doesn't belong to the current state changes nothing.
  assert.match(decodeURIComponent((await post(`${runPath}/action`, { action: 'approve' })).headers.get('location')!), /Nothing changed/);
  assert.match(decodeURIComponent((await post(`${runPath}/action`, { action: 'enable_pilot' })).headers.get('location')!), /Nothing changed/);
  // Only the one-time fetch of Google's country and language lists (2 read-only queries); nothing about the run.
  assert.equal(ads.calls.length, 0);
  assert.ok(ads.queries.length === 2 && ads.queries.every((q) => /FROM (geo_target_constant|language_constant)/.test(q)));
  const tooLong = await post(`${runPath}/action`, { action: 'confirm_themes', themes: 'Chicken\nA theme name that is far too long to be used' });
  assert.match(decodeURIComponent(tooLong.headers.get('location')!), /longer than 30 characters/);
  await post(`${runPath}/action`, { action: 'confirm_themes', themes: 'Chicken\r\nCakes\r\n' });

  // Waits for Approve; the review page shows structure and copy.
  await ticks(3);
  assert.equal((await app.run(run.id))!.waiting, 'approve');
  const review = await (await get(`${runPath}/review`)).text();
  assert.match(review, /Chicken \| 0002/);
  assert.match(review, /Headline Number 1 \| Headline Number 2/);
  assert.match(review, /keywords: [^<]*best chicken soup/);
  assert.match(review, /Approve and start the upload/);
  // Only the one-time fetch of Google's country and language lists (2 read-only queries); nothing about the run.
  assert.equal(ads.calls.length, 0);
  assert.ok(ads.queries.length === 2 && ads.queries.every((q) => /FROM (geo_target_constant|language_constant)/.test(q)));
  await post(`${runPath}/action`, { action: 'approve' });

  // Pilot (1 campaign) uploaded paused; rest waits.
  await ticks(2);
  assert.equal(ads.live().length, 1);
  let text = await (await get(runPath)).text();
  assert.match(text, /Pilot uploaded \(paused\)/);
  assert.match(text, /Enable pilot/);
  assert.match(text, /Upload rest/);
  await post(`${runPath}/action`, { action: 'enable_pilot' });
  await post(`${runPath}/action`, { action: 'upload_rest' });
  await ticks(2);
  assert.equal(ads.live().length, 2);
  assert.equal(ads.live().filter((c) => c.fields.status === 3).length, 1, 'the rest stays paused');
  await post(`${runPath}/action`, { action: 'enable_rest' });
  await ticks(1);
  text = await (await get(runPath)).text();
  assert.match(text, /Uploaded and enabled: 2 campaigns/);

  // Refresh now asks for a new sync.
  const before = (await app.forRun(run.id).get('last_sync'))!;
  await new Promise((r) => setTimeout(r, 5));
  await post(`${runPath}/action`, { action: 'refresh' });
  await ticks(1);
  assert.notEqual(await app.forRun(run.id).get('last_sync'), before);

  // Report: one line per row of the file.
  const report = await get(`${runPath}/report.csv`);
  assert.match(report.headers.get('content-disposition')!, /attachment/);
  const rows = parseCsv(await report.text());
  assert.deepEqual(rows.slice(1).map((r) => [r[0], r[4], r[5]]), [
    ['2', 'Created', ''],
    ['3', 'Created', ''],
    ['4', 'Created', ''],
    ['5', 'Not created', 'same URL as row 4 (one ad per URL)'],
    ['6', 'Not created', 'missing title'],
  ]);
  assert.equal(rows[1][3], 'chicken soup, best chicken soup');
  assert.equal(rows[1][10], 'APPROVED (REVIEWED)');

  // A second run with a URL of the first: allowed, with a warning.
  const again = await post('/runs/new', { ...RUN_FORM, name: 'Second', review: 'no', domain_id: String(domain.id), csv: 'URL,Title,Keyword\nhttps://example.com/cake-1/,Cake,cake', step: 'check' });
  assert.match(await again.text(), /Warning: 1 URLs are already in an earlier run/);

  // The overview lists the run and the operations used; the cap can be changed.
  const overview = await (await get('/')).text();
  assert.match(overview, /First run/);
  assert.equal((await post('/settings/cap', { cap: '9000' })).status, 303);
  assert.equal(await app.getSetting('daily_cap'), '9000');
  assert.equal((await post('/settings/cap', { cap: '20000' })).status, 400);
  assert.equal(await app.getSetting('daily_cap'), '9000');
});

test('text from the file is shown as text, never as HTML', async () => {
  const { app, get, post, login, ticks } = await start();
  await login();
  await post('/domains/new', { ...settingsToForm(DEFAULT_SETTINGS), name: '<b>x</b>.com' });
  const [domain] = await app.domains();
  const csv = 'URL,Title,Keyword\nhttps://example.com/a/,"<script>alert(1)</script>","chicken <img src=x>"';
  const started = await post('/runs/new', { ...RUN_FORM, name: '<i>run</i>', review: 'no', domain_id: String(domain.id), csv, step: 'start' });
  const runPath = started.headers.get('location')!;
  await ticks(4);
  for (const path of ['/', '/domains', runPath, `${runPath}/review`]) {
    const text = await (await get(path)).text();
    assert.doesNotMatch(text, /<script>alert|<img src=x>|<i>run<\/i>|<b>x<\/b>/, path);
  }
  assert.match(await (await get(`${runPath}/review`)).text(), /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('CSV reading and writing', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","he said ""hi"""\n"two\nlines",z'), [['a', 'b'], ['x, y', 'he said "hi"'], ['two\nlines', 'z']]);
  assert.deepEqual(parseCsv(toCsv([['a,b', 'c"d', 'e\nf', 5, null]])), [['a,b', 'c"d', 'e\nf', '5', '']]);
  assert.deepEqual(readInput('Title,Keyword\nx,y').problems, ['no "URL" column in the first row']);
  assert.deepEqual(readInput('').problems, ['the file is empty']);
  const input = readInput('﻿Keywords, Title ,URL\n"a,  b , a",T,https://x.com/1\n');
  assert.deepEqual(input.articles, [{ rowNumber: 2, url: 'https://x.com/1', title: 'T', keywords: ['a', 'b'] }]);
});

test('settings form: every wrong value is reported, nothing is corrected silently', () => {
  const good = parseSettings({ ...settingsToForm({ ...DEFAULT_SETTINGS, account: '197-844-9758', labels: ['A', 'B'] }), review: 'no' }, true);
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.settings.labels, ['A', 'B']);
  assert.equal(good.settings.review, false);
  const bad = parseSettings({ account: '12', labels: '', namePattern: 'x', numbering: '', maxCpc: 'abc', budget: '0', countries: '', languages: 'english', matchType: 'x', adsPerAdGroup: '4', adGroupsPerCampaign: '0', pilot: '-1', model: 'gpt', review: '' }, true);
  assert.equal(bad.problems.length, 14, bad.problems.join('\n'));
});

test('countries and languages: Google\'s lists are loaded once and offered by name; before that the forms take codes', async () => {
  const { app, get, post, login, ads, ticks, batches } = await start();
  await login();
  // Not loaded yet: plain code fields.
  let form = await (await get('/domains/new')).text();
  assert.match(form, /name="countries" value="US"/);
  assert.match(form, /Google&#39;s list of names is not loaded yet|Google's list of names is not loaded yet/);
  assert.doesNotMatch(form, /data-picker/);

  // The first account asked can't answer; the next one can. The failure is shown until then.
  const asked: string[] = [];
  const deps: Deps = { app, batches, listsAccount: '111-111-1111', adsFor: (id) => (asked.push(id), ads) };
  ads.failLists = true;
  await tickAll(deps);
  assert.match(await (await get('/')).text(), /could not be loaded yet[\s\S]*Not allowed for this customer/);
  await tickAll(deps);
  assert.equal(asked.length, 1, 'not tried again within 30 minutes');
  ads.failLists = false;
  await app.setSetting('google_lists_tried', new Date(Date.now() - 31 * 60 * 1000).toISOString());
  await tickAll(deps);
  const queriesAfterLoad = ads.queries.length;
  await tickAll(deps);
  assert.equal(ads.queries.length, queriesAfterLoad, 'loaded once, never fetched again');
  assert.doesNotMatch(await (await get('/')).text(), /could not be loaded yet/);

  // Loaded: pick by full name; the form still posts codes.
  form = await (await get('/domains/new')).text();
  assert.match(form, /data-picker/);
  assert.match(form, /<option value="United Kingdom" data-code="GB">/);
  assert.match(form, /<option value="Chinese \(simplified\)" data-code="zh_CN">/);
  assert.match(form, /<input type="hidden" name="countries" value="US">/);
  const unknown = await post('/domains/new', { ...settingsToForm(DEFAULT_SETTINGS), name: 'a.com', countries: 'US, XX', languages: 'en, xx' });
  assert.equal(unknown.status, 400);
  const unknownText = await unknown.text();
  assert.match(unknownText, /Country &quot;XX&quot; is not in Google&#39;s list of countries/);
  assert.match(unknownText, /Language &quot;xx&quot; is not in Google&#39;s list of languages/);
  assert.equal((await post('/domains/new', { ...settingsToForm({ ...DEFAULT_SETTINGS, account: '197-000-0000', labels: ['L'] }), name: 'a.com', countries: 'US, GB', languages: 'en, zh_CN' })).status, 303);
  const [domain] = await app.domains();
  assert.deepEqual(domain.defaults.languages, ['en', 'zh_CN']);

  // A run with those settings: names on the run page, and Google gets both countries and both languages.
  const started = await post('/runs/new', { ...settingsToForm(domain.defaults), name: 'Names', review: 'no', domain_id: String(domain.id), csv: 'URL,Title,Keyword\nhttps://a.com/1/,Chicken,chicken', step: 'start' });
  const runPath = started.headers.get('location')!;
  await ticks(4);
  const text = await (await get(runPath)).text();
  assert.match(text, /United Kingdom, United States|United States, United Kingdom/);
  assert.match(text, /English, Chinese \(simplified\)/);
  const [campaign] = ads.live();
  assert.deepEqual(campaign.locations.sort(), ['geoTargetConstants/2826', 'geoTargetConstants/2840']);
  assert.deepEqual(campaign.languages.sort(), ['languageConstants/1000', 'languageConstants/1017']);
});

test('daily sync can be turned off per run; "Refresh now" still works', async () => {
  const { app, get, post, login, ticks } = await start();
  await login();
  await post('/domains/new', { ...settingsToForm({ ...DEFAULT_SETTINGS, account: '197-000-0000', labels: ['L'] }), name: 'a.com' });
  const [domain] = await app.domains();
  const started = await post('/runs/new', { ...settingsToForm(domain.defaults), name: 'Sync', review: 'no', domain_id: String(domain.id), csv: 'URL,Title,Keyword\nhttps://a.com/1/,Chicken,chicken', step: 'start' });
  const runPath = started.headers.get('location')!;
  const db = app.forRun(1);
  await ticks(4);
  const first = (await db.get('last_sync'))!;
  assert.ok(first);
  assert.match(await (await get(runPath)).text(), /Daily sync of Google's review results: <b>on<\/b>/);
  // A day later the daily sync is due.
  const dayAgo = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  await db.set('last_sync', dayAgo);
  await post(`${runPath}/action`, { action: 'toggle_daily_sync' });
  assert.match(await (await get(runPath)).text(), /Daily sync of Google's review results: <b>off<\/b>/);
  await ticks(2);
  assert.equal(await db.get('last_sync'), dayAgo, 'no daily sync while it is off');
  await post(`${runPath}/action`, { action: 'refresh' });
  await ticks(1);
  assert.notEqual(await db.get('last_sync'), dayAgo, 'Refresh now works with daily sync off');
  await db.set('last_sync', dayAgo);
  await post(`${runPath}/action`, { action: 'toggle_daily_sync' });
  await ticks(1);
  assert.notEqual(await db.get('last_sync'), dayAgo, 'daily sync runs again once it is on');
});
