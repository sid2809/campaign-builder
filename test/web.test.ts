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
  assert.equal(ads.calls.length + ads.queries.length, 0);
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
  assert.equal(ads.calls.length + ads.queries.length, 0);
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
