// The dashboard: plain server-rendered pages over node:http. One password, one signed session cookie.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import type { AppDb, RunRow } from './db.ts';
import { readInput, toCsv } from './csv.ts';
import { reportRows } from './report.ts';
import { cleanThemes, OTHER_THEME } from './grouping.ts';
import { dailyCap, DAILY_SYNC_DAYS } from './engine.ts';
import { DEFAULT_SETTINGS, parseSettings, settingsToForm, type RunSettings } from './settings.ts';
import { listProblems, loadLists, namesOf, type Lists } from './lists.ts';
import { chip, esc, fmtDate, page, problemsBox, settingsFields, statusChip } from './views.ts';
import { log } from './log.ts';

export interface WebOptions {
  password: string;
  secret?: string;
}

const SESSION_DAYS = 30;
const MAX_BODY = 40 * 1024 * 1024;
const REVIEW_PAGE_SIZE = 20;

type Form = Record<string, string>;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createWeb(app: AppDb, options: WebOptions): Server {
  const secret = options.secret || createHash('sha256').update(`campaign-builder:${options.password}`).digest('hex');
  const sign = (value: string) => createHmac('sha256', secret).update(value).digest('hex');
  const sessionCookie = () => {
    const expires = String(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
    return `${expires}.${sign(expires)}`;
  };
  const signedIn = (req: IncomingMessage): boolean => {
    const raw = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith('cb='))?.slice(3) ?? '';
    const [expires, mac] = raw.split('.');
    if (!expires || !mac || Number(expires) < Date.now()) return false;
    return safeEqual(mac, sign(expires));
  };
  const failures: number[] = []; // times of failed sign-ins (all visitors together)

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';
    const secure = req.headers['x-forwarded-proto'] === 'https';
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', ...headers });
      res.end(body);
    };
    const redirect = (to: string, headers: Record<string, string> = {}) => send(303, '', { location: to, ...headers });

    if (path === '/health') return send(200, 'ok', { 'content-type': 'text/plain' });

    // A form may only be posted from the dashboard itself.
    if (method === 'POST') {
      const origin = req.headers.origin;
      if (origin && !sameHost(origin, req.headers.host)) throw new HttpError(403, 'This form was not sent from the dashboard.');
    } else if (method !== 'GET') throw new HttpError(405, 'Method not allowed');

    if (path === '/login') {
      if (method === 'GET') return send(200, loginPage(''));
      const form = await readForm(req);
      const recent = failures.filter((t) => t > Date.now() - 15 * 60 * 1000);
      if (recent.length >= 10) return send(429, loginPage('Too many wrong passwords. Try again in 15 minutes.'));
      if (!safeEqual(sign(form.password ?? ''), sign(options.password))) {
        failures.push(Date.now());
        await new Promise((r) => setTimeout(r, 500));
        return send(401, loginPage('Wrong password.'));
      }
      return redirect('/', { 'set-cookie': `cb=${sessionCookie()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 24 * 3600}${secure ? '; Secure' : ''}` });
    }
    if (!signedIn(req)) return redirect('/login');
    if (path === '/logout' && method === 'POST') return redirect('/login', { 'set-cookie': 'cb=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });

    // ---------- overview ----------
    if (path === '/' && method === 'GET') return send(200, await overviewPage());
    if (path === '/settings/cap' && method === 'POST') {
      const form = await readForm(req);
      const cap = Number((form.cap ?? '').trim());
      if (!Number.isInteger(cap) || cap < 100 || cap > 15000) return send(400, await overviewPage(`Daily cap: "${form.cap}" is not a whole number from 100 to 15000 (Google's limit for the token is 15,000 a day).`));
      await app.setSetting('daily_cap', String(cap));
      return redirect('/');
    }

    // ---------- domains ----------
    if (path === '/domains' && method === 'GET') return send(200, await domainsPage());
    if (path === '/domains/new') {
      if (method === 'GET') return send(200, domainForm('New domain', '/domains/new', '', settingsToForm(DEFAULT_SETTINGS), [], await loadLists(app)));
      const form = await readForm(req);
      const { name, settings, problems } = await readDomainForm(form, undefined);
      if (problems.length > 0) return send(400, domainForm('New domain', '/domains/new', form.name ?? '', form, problems, await loadLists(app)));
      await app.createDomain(name, settings);
      return redirect('/domains');
    }
    const domainMatch = path.match(/^\/domains\/(\d+)$/);
    if (domainMatch) {
      const domain = await app.domain(Number(domainMatch[1]));
      if (!domain) throw new HttpError(404, 'Domain not found');
      const action = `/domains/${domain.id}`;
      if (method === 'GET') return send(200, domainForm(`Domain: ${domain.name}`, action, domain.name, settingsToForm({ ...DEFAULT_SETTINGS, ...domain.defaults }), [], await loadLists(app)));
      const form = await readForm(req);
      const { name, settings, problems } = await readDomainForm(form, domain.id);
      if (problems.length > 0) return send(400, domainForm(`Domain: ${domain.name}`, action, form.name ?? '', form, problems, await loadLists(app)));
      await app.updateDomain(domain.id, name, settings);
      return redirect('/domains');
    }

    // ---------- new run ----------
    if (path === '/runs/new') {
      if (method === 'GET') {
        const domains = await app.domains();
        const domain = domains.find((d) => String(d.id) === url.searchParams.get('domain'));
        if (!domain) return send(200, pickDomainPage(domains));
        const values = settingsToForm({ ...DEFAULT_SETTINGS, ...domain.defaults });
        delete values.review; // asked on every run, never pre-filled
        return send(200, runForm(domain.id, domain.name, { ...values, name: '' }, '', [], false, await loadLists(app)));
      }
      const form = await readForm(req);
      const domain = await app.domain(Number(form.domain_id));
      if (!domain) throw new HttpError(400, 'Domain not found');
      const { settings, problems } = parseSettings(form, true);
      const lists = await loadLists(app);
      problems.push(...listProblems(lists, settings.countries, settings.languages));
      const name = (form.name ?? '').trim();
      if (!name) problems.push('Run name: required');
      const csv = form.csv ?? '';
      const input = csv.trim() ? readInput(csv) : { problems: ['Articles: choose a CSV file or paste the rows'], articles: [], skipped: [] };
      for (const p of input.problems) problems.push(`Articles: ${p}`);
      const earlier = problems.length === 0 ? await app.urlsInEarlierRuns(input.articles.map((a) => a.url)) : [];
      const summary = input.problems.length === 0 ? importSummary(input.articles.length, input.skipped, earlier) : '';
      if (problems.length > 0 || form.step !== 'start') return send(problems.length > 0 ? 400 : 200, runForm(domain.id, domain.name, form, summary, problems, problems.length === 0, lists));
      const runId = await app.createRun(domain.id, name, settings, input.articles, input.skipped);
      log(`run ${runId} created: "${name}" for ${domain.name}, ${input.articles.length} articles, ${input.skipped.length} rows not created`);
      return redirect(`/runs/${runId}`);
    }

    // ---------- one run ----------
    const runMatch = path.match(/^\/runs\/(\d+)(\/review|\/report\.csv|\/action)?$/);
    if (runMatch) {
      const run = await app.run(Number(runMatch[1]));
      if (!run) throw new HttpError(404, 'Run not found');
      const sub = runMatch[2] ?? '';
      if (sub === '' && method === 'GET') return send(200, await runPage(run, url.searchParams.get('msg') ?? ''));
      if (sub === '/review' && method === 'GET') return send(200, await reviewPage(run, Math.max(1, Number(url.searchParams.get('page')) || 1)));
      if (sub === '/report.csv' && method === 'GET') {
        const csv = toCsv(await reportRows(app.forRun(run.id)));
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="run-${run.id}-report.csv"`, 'cache-control': 'no-store' });
        res.end(`﻿${csv}`);
        return;
      }
      if (sub === '/action' && method === 'POST') {
        const form = await readForm(req);
        const message = await runAction(run, form);
        return redirect(`/runs/${run.id}?msg=${encodeURIComponent(message)}`);
      }
    }
    throw new HttpError(404, 'Page not found');
  }

  // ---------- actions (the dashboard's buttons) ----------
  // Each button only works in the state it belongs to; otherwise it changes nothing and says why.
  async function runAction(run: RunRow, form: Form): Promise<string> {
    const db = app.forRun(run.id);
    const state = await db.state();
    const campaigns = await db.campaigns();
    const cleared = !run.settings.review || state.approved === '1';
    const waveReady = (wave: 'pilot' | 'rest') => campaigns.some((c) => c.wave === wave && c.status === 'uploaded' && !c.enabled_at);
    const go = async (key: string, value: string, status: string | undefined, message: string) => {
      await db.set(key, value);
      await db.setFinished(false);
      if (status) await db.setStatus(status);
      log(`run ${run.id}: ${form.action}`);
      return message;
    };
    switch (form.action) {
      case 'confirm_themes': {
        if (run.waiting !== 'themes') return 'Nothing changed: the run is not waiting for theme confirmation.';
        const themes = cleanThemes((form.themes ?? '').split('\n'));
        const typed = (form.themes ?? '').split('\n').map((t) => t.trim()).filter(Boolean);
        const dropped = typed.filter((t) => t.toLowerCase() !== OTHER_THEME.toLowerCase() && !themes.some((x) => x.toLowerCase() === t.replace(/[|{}]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()));
        if (dropped.length > 0) return `Nothing changed: these themes are longer than 30 characters: ${dropped.join(', ')}`;
        return go('themes', JSON.stringify(themes), 'Grouping: themes confirmed', `Themes confirmed: ${themes.length} (including "${OTHER_THEME}").`);
      }
      case 'approve':
        if (run.waiting !== 'approve') return 'Nothing changed: the run is not waiting for approval.';
        return go('approved', '1', 'Approved: starting the upload', 'Approved. Campaigns will be created paused.');
      case 'upload_rest':
        if (run.settings.pilot === 0 || !cleared || state.grouped !== '1') return 'Nothing changed: "Upload rest" is not available for this run now.';
        if (state.upload_rest === '1') return 'Nothing changed: "Upload rest" was already asked.';
        return go('upload_rest', '1', undefined, 'The rest will be uploaded (paused) once every pilot campaign is done.');
      case 'enable_pilot':
      case 'enable_rest': {
        const wave = form.action === 'enable_pilot' ? 'pilot' : 'rest';
        if (!waveReady(wave)) return 'Nothing changed: there are no uploaded campaigns waiting to be enabled.';
        return go(`enable_${wave}`, 'requested', undefined, 'The campaigns will be enabled within a minute.');
      }
      case 'refresh':
        if (!campaigns.some((c) => c.status === 'uploaded')) return 'Nothing changed: nothing is uploaded yet.';
        return go('sync_requested', '1', undefined, "Google's review results will be fetched within a minute.");
      case 'toggle_daily_sync': {
        const turnOff = state.daily_sync !== 'off';
        await db.set('daily_sync', turnOff ? 'off' : 'on');
        if (!turnOff) await db.setFinished(false);
        log(`run ${run.id}: daily sync ${turnOff ? 'off' : 'on'}`);
        return turnOff ? 'Daily sync is off for this run. "Refresh now" still works.' : 'Daily sync is on for this run.';
      }
      case 'retry_preflight':
        if (state.preflight !== 'failed') return 'Nothing changed: the preflight has not failed.';
        return go('preflight', '', 'Trying the preflight again', 'The preflight will run again within a minute.');
      default:
        throw new HttpError(400, 'Unknown action');
    }
  }

  // ---------- pages ----------
  function loginPage(error: string): string {
    return page(
      'Sign in',
      '',
      `<div class="card login"><h1>Campaign Builder</h1><p class="sub">Sign in to continue.</p>${error ? `<div class="note bad">${esc(error)}</div>` : ''}
<form method="post" action="/login"><label for="password">Password</label><input type="password" id="password" name="password" autofocus required>
<p style="margin-top:14px"><button>Sign in</button></p></form></div>`,
      false,
    );
  }

  async function overviewPage(error = ''): Promise<string> {
    const runs = await app.runs();
    const used = await app.opsLast24h();
    const cap = await dailyCap(app);
    const quotaUntil = await app.getSetting('google_quota_until');
    const waitingQuota = quotaUntil && Date.parse(quotaUntil) > Date.now();
    const listsError = (await loadLists(app)) ? '' : await app.getSetting('google_lists_error');
    const rows = runs
      .map(
        (r) => `<tr><td><a href="/runs/${r.id}">${esc(r.name)}</a></td><td>${esc(r.domain_name)}</td><td>${esc(r.settings.account)}</td><td>${statusChip(r.status, r.waiting)}</td><td>${fmtDate(r.created_at)}</td></tr>`,
      )
      .join('');
    return page(
      'Runs',
      'runs',
      `<h1>Runs</h1><p class="sub">Every run, newest first.</p>
${error ? `<div class="note bad">${esc(error)}</div>` : ''}
${listsError ? `<div class="note warn">Google's lists of countries and languages could not be loaded yet, so the forms take codes (US, en) for now. It is tried again every 30 minutes. Reason: ${esc(listsError)}</div>` : ''}
${waitingQuota ? `<div class="note warn">Google's daily API limit for the developer token is used up. Uploads resume at ${esc(fmtDate(quotaUntil))}.</div>` : ''}
<div class="card"><h2>Google Ads API operations</h2>
<div class="actions"><div><b>${used.toLocaleString('en-US')}</b> used in the last 24 hours by this app, of a daily cap of <b>${cap.toLocaleString('en-US')}</b>.</div>
<form class="inline actions" method="post" action="/settings/cap"><input type="text" name="cap" value="${cap}" style="width:110px" aria-label="Daily cap"><button class="quiet">Save cap</button></form></div>
<p class="hint">Google allows 15,000 operations a day for the developer token, shared with every other tool on it (the display pipeline, the Faith and Kitchen services). This app only counts its own.</p></div>
<div class="card">${runs.length === 0 ? '<p class="muted">No runs yet. <a href="/runs/new">Start one</a>.</p>' : `<table><tr><th>Run</th><th>Domain</th><th>Account</th><th>Status</th><th>Created</th></tr>${rows}</table>`}</div>`,
    );
  }

  async function domainsPage(): Promise<string> {
    const domains = await app.domains();
    const rows = domains
      .map(
        (d) =>
          `<tr><td><a href="/domains/${d.id}">${esc(d.name)}</a></td><td>${esc(d.defaults.account)}</td><td>${esc((d.defaults.labels ?? []).join(', '))}</td><td class="num">${d.last_number}</td><td><a href="/runs/new?domain=${d.id}">New run</a></td></tr>`,
      )
      .join('');
    return page(
      'Domains',
      'domains',
      `<h1>Domains</h1><p class="sub">Each domain keeps the default settings its runs start from.</p>
<div class="card">${domains.length === 0 ? '<p class="muted">No domains yet.</p>' : `<table><tr><th>Domain</th><th>Account</th><th>Labels</th><th class="num">Last campaign number</th><th></th></tr>${rows}</table>`}</div>
<a class="btn" href="/domains/new">Add a domain</a>`,
    );
  }

  async function readDomainForm(form: Form, id: number | undefined): Promise<{ name: string; settings: RunSettings; problems: string[] }> {
    const { settings, problems } = parseSettings(form, false);
    problems.push(...listProblems(await loadLists(app), settings.countries, settings.languages));
    const name = (form.name ?? '').trim();
    if (!name) problems.push('Domain name: required');
    else if ((await app.domains()).some((d) => d.name.toLowerCase() === name.toLowerCase() && d.id !== id)) problems.push(`Domain name: "${name}" already exists`);
    return { name, settings, problems };
  }

  function domainForm(title: string, action: string, name: string, values: Form, problems: string[], lists: Lists | undefined): string {
    return page(
      title,
      'domains',
      `<h1>${esc(title)}</h1><p class="sub">Defaults for this domain's runs. Every run can change them for itself.</p>${problemsBox(problems)}
<form method="post" action="${action}"><div class="card"><div class="fields"><div><label for="name">Domain name</label><input type="text" id="name" name="name" value="${esc(name)}" required><p class="hint">e.g. ponly.com</p></div></div></div>
<div class="card"><h2>Default settings</h2>${settingsFields(values, false, lists)}</div><div class="actions"><button>Save</button><a class="btn quiet" href="/domains">Cancel</a></div></form>`,
    );
  }

  function pickDomainPage(domains: { id: number; name: string }[]): string {
    return page(
      'New run',
      'new',
      `<h1>New run</h1><p class="sub">Pick the domain this list of articles belongs to.</p>
<div class="card">${domains.length === 0 ? '<p class="muted">Add a domain first.</p><a class="btn" href="/domains/new">Add a domain</a>' : `<table>${domains.map((d) => `<tr><td><a href="/runs/new?domain=${d.id}">${esc(d.name)}</a></td></tr>`).join('')}</table>`}</div>`,
    );
  }

  function importSummary(count: number, skipped: { row_number: number; url: string; reason: string }[], earlier: { url: string; run_id: number; run_name: string }[]): string {
    const skippedRows = skipped.slice(0, 50).map((s) => `<tr><td class="num">${s.row_number}</td><td>${esc(s.url)}</td><td>${esc(s.reason)}</td></tr>`).join('');
    const earlierRows = earlier.slice(0, 50).map((e) => `<tr><td>${esc(e.url)}</td><td><a href="/runs/${e.run_id}">${esc(e.run_name)}</a></td></tr>`).join('');
    return `<div class="card"><h2>What the file holds</h2><p><b>${count.toLocaleString('en-US')}</b> articles will become ads.</p>
${
  skipped.length > 0
    ? `<div class="note warn"><b>${skipped.length} rows can't become an ad.</b> They are listed in the run's final report.${skipped.length > 50 ? ' The first 50:' : ''}</div><table><tr><th class="num">Row</th><th>URL</th><th>Reason</th></tr>${skippedRows}</table>`
    : '<p class="muted">Every row has a URL, a title and a keyword, and no URL is repeated.</p>'
}
${
  earlier.length > 0
    ? `<div class="note warn" style="margin-top:14px"><b>Warning: ${earlier.length} URLs are already in an earlier run.</b> They are allowed and will get a new ad in this run.${earlier.length > 50 ? ' The first 50:' : ''}</div><table><tr><th>URL</th><th>Earlier run</th></tr>${earlierRows}</table>`
    : ''
}</div>`;
  }

  function runForm(domainId: number, domainName: string, values: Form, summary: string, problems: string[], checked: boolean, lists: Lists | undefined): string {
    return page(
      'New run',
      'new',
      `<h1>New run for ${esc(domainName)}</h1><p class="sub">Upload the articles, set this run's options, check the file, then start.</p>${problemsBox(problems)}${summary}
<form method="post" action="/runs/new" id="run"><input type="hidden" name="domain_id" value="${domainId}">
<div class="card"><h2>Articles</h2><div class="fields">
<div><label for="name">Run name</label><input type="text" id="name" name="name" value="${esc(values.name ?? '')}" required><p class="hint">For your own reference, e.g. "Kitchen batch 2".</p></div>
<div><label for="file">CSV file</label><input type="file" id="file" accept=".csv,text/csv"><p class="hint">Columns: URL, Title, Keyword. Several keywords for one URL: in the Keyword cell, separated by commas.</p></div>
<div class="wide"><label for="csv">Rows</label><textarea id="csv" name="csv" placeholder="Choose a file above, or paste the CSV here (first line: URL,Title,Keyword)">${esc(values.csv ?? '')}</textarea></div></div></div>
<div class="card"><h2>Settings for this run</h2>${settingsFields(values, true, lists)}</div>
<div class="actions"><button name="step" value="check" class="quiet">Check the file</button>
<button name="step" value="start"${checked ? '' : ' disabled title="Check the file first"'}>Start run</button>
<span class="muted">${checked ? 'Checked. Starting creates the run; nothing reaches Google Ads until the upload step.' : 'Check the file first; then "Start run" becomes available.'}</span></div></form>
<script>
document.getElementById('file').addEventListener('change', function () {
  var f = this.files[0]; if (!f) return;
  var r = new FileReader(); r.onload = function () { document.getElementById('csv').value = r.result; }; r.readAsText(f);
});
document.getElementById('run').addEventListener('input', function () {
  var b = document.querySelector('button[value=start]'); b.disabled = true; b.title = 'Check the file first';
});
</script>`,
    );
  }

  async function runPage(run: RunRow, message: string): Promise<string> {
    const db = app.forRun(run.id);
    const [state, counts, campaigns, domain] = [await db.state(), await db.counts(), await db.campaigns(), await app.domain(run.domain_id)];
    const s = run.settings;
    const lists = await loadLists(app);
    const dailyOn = state.daily_sync !== 'off';
    const stat = (value: number | string, label: string) => `<div class="stat"><b>${typeof value === 'number' ? value.toLocaleString('en-US') : esc(value)}</b><span>${label}</span></div>`;
    const button = (action: string, label: string, quiet = false) =>
      `<form class="inline" method="post" action="/runs/${run.id}/action"><input type="hidden" name="action" value="${action}"><button${quiet ? ' class="quiet"' : ''}>${label}</button></form>`;
    const cleared = !s.review || state.approved === '1';
    const waveReady = (wave: string) => campaigns.some((c) => c.wave === wave && c.status === 'uploaded' && !c.enabled_at);
    const uploadedAny = campaigns.some((c) => c.status === 'uploaded');
    const buttons: string[] = [];
    if (run.waiting === 'themes') buttons.push(`<a class="btn" href="/runs/${run.id}/review">Confirm the themes</a>`);
    if (run.waiting === 'approve') buttons.push(`<a class="btn" href="/runs/${run.id}/review">Review and approve</a>`);
    if (state.preflight === 'failed') buttons.push(button('retry_preflight', 'Try the preflight again'));
    if (waveReady('pilot') && state.enable_pilot !== 'requested') buttons.push(button('enable_pilot', 'Enable pilot'));
    if (s.pilot > 0 && cleared && state.grouped === '1' && state.upload_rest !== '1' && campaigns.some((c) => c.wave === 'rest' && c.status === 'pending')) buttons.push(button('upload_rest', 'Upload rest'));
    if (waveReady('rest') && state.enable_rest !== 'requested') buttons.push(button('enable_rest', s.pilot > 0 ? 'Enable rest' : 'Enable campaigns'));
    if (uploadedAny) buttons.push(button('refresh', 'Refresh now', true));
    buttons.push(button('toggle_daily_sync', dailyOn ? 'Turn daily sync off' : 'Turn daily sync on', true));
    if (state.grouped === '1' && !run.waiting) buttons.push(`<a class="btn quiet" href="/runs/${run.id}/review">See structure and copy</a>`);
    buttons.push(`<a class="btn quiet" href="/runs/${run.id}/report.csv">Download report (CSV)</a>`);

    const adsOf = await db.adsPerCampaign();
    const campaignRows = campaigns
      .slice(0, 1000)
      .map(
        (c) =>
          `<tr><td>${esc(c.name)}</td><td>${c.wave === 'pilot' ? chip('pilot') : ''}</td><td>${
            c.status === 'uploaded' ? chip(c.enabled_at ? 'enabled' : 'paused', c.enabled_at ? 'ok' : '') : c.status === 'failed' ? chip('not created', 'bad') : chip('waiting')
          }</td><td class="num">${adsOf.get(c.name) ?? 0}</td><td>${esc(c.campaign_id ?? '')}</td><td>${esc(c.serving_status ?? '')}</td><td>${esc(c.error ?? '')}</td></tr>`,
      )
      .join('');
    const setting = (label: string, value: string) => `<tr><td class="muted">${label}</td><td>${esc(value)}</td></tr>`;
    return page(
      run.name,
      'runs',
      `<h1>${esc(run.name)}</h1><p class="sub">${esc(domain?.name ?? '')} · account ${esc(s.account)} · created ${fmtDate(run.created_at)}</p>
${message ? `<div class="note ok">${esc(message)}</div>` : ''}
<div class="card"><h2>Status</h2><p>${statusChip(run.status, run.waiting)}</p>${run.status.length > 90 ? `<p>${esc(run.status)}</p>` : ''}
<div class="actions">${buttons.join('')}</div>
${state.preflight_notes ? `<p class="hint" style="margin-top:12px"><b>Preflight ${esc(state.preflight ?? '')}:</b> ${esc(state.preflight_notes)}</p>` : ''}
<p class="hint">Daily sync of Google's review results: <b>${dailyOn ? 'on' : 'off'}</b>${dailyOn ? ` (once a day, for ${DAILY_SYNC_DAYS} days after the last upload)` : ''}. "Refresh now" works either way.${state.last_sync ? ` Last fetched ${fmtDate(state.last_sync)}.` : ''}</p>
<p class="hint">This page does not refresh by itself; reload it to see progress. The worker acts about once a minute.</p></div>
<div class="grid" style="margin-bottom:18px">
${stat(counts.articles, 'articles')}${stat(counts.skipped, "rows that can't become an ad")}${stat(counts.copy_done, 'with ad copy')}${stat(counts.campaigns, 'campaigns planned')}
${stat(counts.campaigns_uploaded, 'campaigns created')}${stat(counts.campaigns_enabled, 'campaigns enabled')}${stat(counts.ads_uploaded, 'ads created')}
${stat(counts.ads_rejected + counts.ads_no_copy, 'ads not created')}${stat(counts.approved, 'ads approved')}${stat(counts.disapproved, 'ads disapproved')}</div>
<div class="card"><h2>Campaigns</h2>${
        campaigns.length === 0
          ? '<p class="muted">Not grouped yet.</p>'
          : `<table><tr><th>Campaign</th><th></th><th>State</th><th class="num">Ads</th><th>Google ID</th><th>Google status</th><th>Error</th></tr>${campaignRows}</table>${campaigns.length > 1000 ? '<p class="hint">The first 1,000 are shown. The report has everything.</p>' : ''}`
      }</div>
<div class="card"><h2>Settings of this run</h2><table>
${setting('Labels', s.labels.join(', '))}${setting('Campaign name pattern', s.namePattern)}${setting('Numbering', s.numbering)}
${setting('Bidding', `Maximize Clicks, max CPC ₹${s.maxCpc}`)}${setting('Daily budget per campaign', `₹${s.budget}`)}
${setting('Countries (presence)', namesOf(lists?.countries, s.countries, 'Worldwide (no location targeting)'))}${setting('Languages', namesOf(lists?.languages, s.languages))}${setting('Match type', s.matchType)}
${setting('Structure', `${s.adsPerAdGroup} ads per ad group, ${s.adGroupsPerCampaign} ad groups per campaign`)}${setting('Pilot', s.pilot > 0 ? `${s.pilot} campaigns` : 'none')}
${setting('Review before publishing', s.review ? 'yes' : 'no')}${setting('Model', s.model)}${setting('Copy instructions', s.copyRules || 'default rules')}
</table></div>`,
    );
  }

  async function reviewPage(run: RunRow, pageNumber: number): Promise<string> {
    const db = app.forRun(run.id);
    const state = await db.state();
    const back = `<p><a href="/runs/${run.id}">← Back to the run</a></p>`;
    if (run.waiting === 'themes') {
      const proposed: string[] = JSON.parse(state.themes_proposed ?? '[]');
      const count = (await db.counts()).articles;
      return page(
        'Confirm themes',
        'runs',
        `${back}<h1>Confirm the themes</h1><p class="sub">${esc(run.name)} · ${count.toLocaleString('en-US')} articles. Each theme becomes one or more campaigns; a campaign never mixes themes.</p>
<form method="post" action="/runs/${run.id}/action"><input type="hidden" name="action" value="confirm_themes">
<div class="card"><label for="themes">Themes, one per line</label><textarea id="themes" name="themes" style="min-height:${Math.min(600, 40 + proposed.length * 21)}px">${esc(proposed.filter((t) => t !== OTHER_THEME).join('\n'))}</textarea>
<p class="hint">Proposed by the model. Edit, add or remove lines. At most 30 characters each. "${OTHER_THEME}" is always added for articles that fit no theme.</p></div>
<button>Confirm themes and continue</button></form>`,
      );
    }
    if (state.grouped !== '1') return page('Review', 'runs', `${back}<h1>Not grouped yet</h1><p class="sub">The structure appears here once grouping is done.</p>`);
    const campaigns = await db.campaigns();
    const pages = Math.max(1, Math.ceil(campaigns.length / REVIEW_PAGE_SIZE));
    const current = Math.min(pageNumber, pages);
    const shown = campaigns.slice((current - 1) * REVIEW_PAGE_SIZE, current * REVIEW_PAGE_SIZE);
    const counts = await db.counts();
    let body = '';
    for (const c of shown) {
      const articles = await db.articlesOf(c.name);
      const groups = [...new Set(articles.map((a) => a.ad_group))];
      body += `<details${shown.length <= 3 ? ' open' : ''}><summary>${esc(c.name)} ${c.wave === 'pilot' ? chip('pilot') : ''} <span class="muted">· ${groups.length} ad groups · ${articles.length} ads</span></summary>${groups
        .map((g) => {
          const inGroup = articles.filter((a) => a.ad_group === g);
          const keywords = [...new Set(inGroup.flatMap((a) => a.keywords.map((k) => k.toLowerCase())))];
          return `<div class="adgroup"><b>${esc(g)}</b> <span class="muted">· keywords: ${esc(keywords.join(', '))}</span>${inGroup
            .map(
              (a) =>
                `<div class="ad"><b>${esc(a.title)}</b> · <a href="${esc(a.url)}" rel="noreferrer noopener" target="_blank">${esc(a.url)}</a><br>${
                  a.copy_status === 'done'
                    ? `Headlines: ${esc((a.headlines ?? []).join(' | '))}<br>Descriptions: ${esc((a.descriptions ?? []).join(' | '))}`
                    : a.copy_status === 'failed'
                      ? chip(`no ad copy: ${a.copy_error ?? 'failed'}`.slice(0, 160), 'bad')
                      : chip('ad copy not written yet')
                }</div>`,
            )
            .join('')}</div>`;
        })
        .join('')}</details>`;
    }
    const pager =
      pages > 1
        ? `<div class="actions" style="margin-top:12px">${current > 1 ? `<a class="btn quiet" href="?page=${current - 1}">← Previous</a>` : ''}<span class="muted">Page ${current} of ${pages}</span>${current < pages ? `<a class="btn quiet" href="?page=${current + 1}">Next →</a>` : ''}</div>`
        : '';
    const approve =
      run.waiting === 'approve'
        ? `<div class="card"><h2>Approve</h2><p>Approving starts the upload. Campaigns are created <b>paused</b>${run.settings.pilot > 0 ? `; the pilot (${counts.pilot_campaigns} campaigns) goes first` : ''}.</p>
${counts.copy_failed > 0 ? `<div class="note warn">${counts.copy_failed} articles have no ad copy after 3 tries. They will not get an ad and will be listed in the report.</div>` : ''}
<form method="post" action="/runs/${run.id}/action"><input type="hidden" name="action" value="approve"><button>Approve and start the upload</button></form></div>`
        : '';
    return page(
      'Review',
      'runs',
      `${back}<h1>Structure and ad copy</h1><p class="sub">${esc(run.name)} · ${counts.campaigns.toLocaleString('en-US')} campaigns · ${counts.articles.toLocaleString('en-US')} ads · read-only</p>
${approve}<div class="card">${body}${pager}</div>`,
    );
  }

  return createServer((req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) log(`web error: ${(error as Error).stack ?? error}`);
      if (res.headersSent) return res.end();
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('Error', '', `<div class="card"><h1>${status === 500 ? 'Something went wrong' : esc((error as Error).message)}</h1><p class="sub">${status === 500 ? 'The error is in the service logs.' : ''}</p><a href="/">Back to the runs</a></div>`, false));
    });
  });
}

function sameHost(origin: string, host: string | undefined): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function readForm(req: IncomingMessage): Promise<Form> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'The file is too large (limit 40 MB).');
    chunks.push(chunk as Buffer);
  }
  const form: Form = {};
  for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) form[key] = value;
  return form;
}
