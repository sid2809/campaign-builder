// Server-rendered pages. Every value shown goes through esc().
import { MATCH_TYPES, MODELS } from './config.ts';
import type { ListItem, Lists } from './lists.ts';

export const esc = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--line:#e3e6eb;--text:#1a1f2b;--muted:#667085;--accent:#3056d3;--accent-text:#fff;--ok:#157a4a;--warn:#9a6700;--bad:#b42318;--chip:#eef1f6}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b23;--line:#2a303b;--text:#e6e9ef;--muted:#98a2b3;--accent:#6f8cf5;--accent-text:#0f1218;--ok:#4cc38a;--warn:#e2b340;--bad:#f97066;--chip:#222834}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--card);border-bottom:1px solid var(--line);padding:0 24px;display:flex;align-items:center;gap:24px;height:52px}
header .brand{font-weight:650;font-size:15px;color:var(--text)}
header nav{display:flex;gap:18px;flex:1}
header nav a{color:var(--muted)}header nav a.on{color:var(--text);font-weight:600}
main{max-width:1180px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:0 0 12px}
.sub{color:var(--muted);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.stat b{display:block;font-size:20px;font-weight:650}.stat span{color:var(--muted);font-size:12px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--muted);font-weight:500;padding:7px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:1px 9px;font-size:12px;white-space:nowrap}
.chip.ok{color:var(--ok)}.chip.warn{color:var(--warn)}.chip.bad{color:var(--bad)}
.note{border-left:3px solid var(--line);padding:8px 12px;margin:0 0 14px;background:var(--chip);border-radius:0 6px 6px 0}
.note.warn{border-color:var(--warn)}.note.bad{border-color:var(--bad)}.note.ok{border-color:var(--ok)}
label{display:block;font-weight:550;margin-bottom:4px}
.hint{color:var(--muted);font-size:12px;font-weight:400;margin:3px 0 0}
input[type=text],input[type=password],input[type=number],select,textarea{width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--text);font:inherit}
textarea{min-height:90px;resize:vertical}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.wide{grid-column:1/-1}
button,.btn{display:inline-block;background:var(--accent);color:var(--accent-text);border:0;border-radius:7px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer}
button.quiet,.btn.quiet{background:transparent;color:var(--text);border:1px solid var(--line)}
button:disabled{opacity:.5;cursor:not-allowed}
.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
form.inline{display:inline}
details{border-top:1px solid var(--line);padding:8px 0}details:first-of-type{border-top:0}
summary{cursor:pointer;font-weight:600}
.adgroup{margin:8px 0 8px 16px}.ad{margin:6px 0 10px 16px;color:var(--muted);font-size:12.5px}.ad b{color:var(--text);font-weight:550}
.picker .chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}.picker .chips:empty{display:none}.chip .x{background:none;border:0;color:var(--muted);padding:0 0 0 2px;font-size:14px;line-height:1;cursor:pointer}
.radio{display:flex;gap:16px}.radio label{font-weight:400;display:flex;gap:6px;align-items:center;margin:0}
.login{max-width:340px;margin:12vh auto}
.muted{color:var(--muted)}
`;

export function page(title: string, active: string, body: string, signedIn = true): string {
  const link = (href: string, label: string, key: string) => `<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Campaign Builder</title><style>${CSS}</style></head><body>
${
  signedIn
    ? `<header><a class="brand" href="/">Campaign Builder</a><nav>${link('/', 'Runs', 'runs')}${link('/domains', 'Domains', 'domains')}${link('/runs/new', 'New run', 'new')}</nav>
<form class="inline" method="post" action="/logout"><button class="quiet">Sign out</button></form></header>`
    : ''
}
<main>${body}</main></body></html>`;
}

export function problemsBox(problems: string[]): string {
  if (problems.length === 0) return '';
  return `<div class="note bad"><b>Not saved. Please fix:</b><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`;
}

// The settings fields shared by a domain's defaults and a new run.
// A pick-by-name field over one of Google's lists. The form still posts the codes (in the hidden input).
function picker(name: string, label: string, items: ListItem[], value: string, hint: string): string {
  return `<div><label for="${name}-search">${label}</label><div class="picker" data-picker>
<div class="chips"></div>
<input type="text" id="${name}-search" list="${name}-list" placeholder="Type a name…" autocomplete="off">
<datalist id="${name}-list">${items.map((i) => `<option value="${esc(i.name)}" data-code="${esc(i.code)}"></option>`).join('')}</datalist>
<input type="hidden" name="${name}" value="${esc(value)}"></div><p class="hint">${hint}</p></div>`;
}

const PICKER_SCRIPT = `<script>
document.querySelectorAll('[data-picker]').forEach(function (box) {
  var hidden = box.querySelector('input[type=hidden]'), search = box.querySelector('input[type=text]'), chips = box.querySelector('.chips');
  var options = Array.prototype.slice.call(box.querySelectorAll('option'));
  var nameOf = {}, codeOf = {};
  options.forEach(function (o) { nameOf[o.dataset.code] = o.value; codeOf[o.value.toLowerCase()] = o.dataset.code; });
  function codes() { return hidden.value.split(',').map(function (c) { return c.trim(); }).filter(Boolean); }
  function set(list) { hidden.value = list.join(', '); draw(); hidden.dispatchEvent(new Event('input', { bubbles: true })); }
  function draw() {
    chips.textContent = '';
    codes().forEach(function (code) {
      var chip = document.createElement('span'); chip.className = 'chip'; chip.textContent = (nameOf[code] || code) + ' ';
      var x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove ' + (nameOf[code] || code));
      x.addEventListener('click', function () { set(codes().filter(function (c) { return c !== code; })); });
      chip.appendChild(x); chips.appendChild(chip);
    });
  }
  function add() {
    var code = codeOf[search.value.trim().toLowerCase()];
    if (!code) return;
    if (codes().indexOf(code) < 0) set(codes().concat([code]));
    search.value = '';
  }
  search.addEventListener('input', add); search.addEventListener('change', add);
  search.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  draw();
});
</script>`;

export function settingsFields(v: Record<string, string>, forRun: boolean, lists?: Lists): string {
  const text = (name: string, label: string, hint: string, extra = '') =>
    `<div><label for="${name}">${label}</label><input type="text" id="${name}" name="${name}" value="${esc(v[name] ?? '')}" ${extra}><p class="hint">${hint}</p></div>`;
  const select = (name: string, label: string, options: [string, string][], hint: string) =>
    `<div><label for="${name}">${label}</label><select id="${name}" name="${name}">${options
      .map(([value, text]) => `<option value="${esc(value)}"${v[name] === value ? ' selected' : ''}>${esc(text)}</option>`)
      .join('')}</select><p class="hint">${hint}</p></div>`;
  const review = forRun
    ? `<div style="grid-column:span 2"><label>Review before publishing?</label><div class="radio">
<label><input type="radio" name="review" value="yes"${v.review === 'yes' ? ' checked' : ''} required> Yes: stop for theme confirmation and Approve</label>
<label><input type="radio" name="review" value="no"${v.review === 'no' ? ' checked' : ''} required> No: go straight to upload</label></div>
<p class="hint">Asked on every run. Campaigns are always created paused.</p></div>`
    : `<input type="hidden" name="review" value="yes">`;
  return `<div class="fields">
${text('account', 'Ad account', 'Google Ads account ID under the MCC, e.g. 197-844-9758. One account per run.')}
${text('labels', 'Labels', 'One or several, separated by commas. Missing labels are created in the account.')}
${text('namePattern', 'Campaign name pattern', '{theme} and {number} are filled in, e.g. "{theme} | {number}" gives "Chicken | 0001".')}
${select('numbering', 'Campaign numbering', [['restart', 'Restart at 0001'], ['continue', "Continue after the domain's last number"]], 'Google does not allow two campaigns with the same name in one account.')}
${text('maxCpc', 'Max CPC cap (₹)', 'Maximize Clicks, with the CPC capped at this.')}
${text('budget', 'Daily budget per campaign (₹)', 'Each campaign gets its own budget.')}
${
    lists
      ? picker('countries', 'Countries', lists.countries, v.countries ?? '', "From Google's list. One or several. People in these countries (presence).")
      : text('countries', 'Countries', "2-letter codes, separated by commas (US, GB, CA). Google's list of names is not loaded yet. People in these countries (presence).")
  }
${
    lists
      ? picker('languages', 'Languages', lists.languages, v.languages ?? '', "From Google's list. One or several.")
      : text('languages', 'Languages', "Language codes, separated by commas (en, es). Google's list of names is not loaded yet.")
  }
${select('matchType', 'Keyword match type', MATCH_TYPES.map((m) => [m, m[0] + m.slice(1).toLowerCase()] as [string, string]), 'Applies to every keyword of the run.')}
${text('adsPerAdGroup', 'Ads per ad group', '1 to 3. Google allows at most 3 enabled responsive search ads in an ad group.')}
${text('adGroupsPerCampaign', 'Ad groups per campaign', 'A campaign never mixes themes.')}
${text('pilot', 'Pilot campaigns', 'How many campaigns go first as a pilot. 0 = no pilot.')}
${select('model', 'Model', MODELS.map((m) => [m, m] as [string, string]), 'Used for themes, tagging and ad copy.')}
${review}
<div class="wide"><label for="copyRules">Copy instructions</label><textarea id="copyRules" name="copyRules" placeholder="Leave empty to use the default rules (no clickbait wording; &quot;Best&quot; and &quot;2026&quot; where natural).">${esc(v.copyRules ?? '')}</textarea>
<p class="hint">One instruction per line. Always 15 headlines (30 characters) and 4 descriptions (90 characters). Tracking suffix: the same as Faith and Kitchen. Networks: Google Search only.</p></div>
</div>${lists ? PICKER_SCRIPT : ''}`;
}

export function chip(text: string, kind: '' | 'ok' | 'warn' | 'bad' = ''): string {
  return `<span class="chip ${kind}">${esc(text)}</span>`;
}

export function statusChip(status: string, waiting: string | null): string {
  const kind = waiting ? 'warn' : /^(Stopped|Error)/.test(status) ? 'bad' : /^Uploaded and enabled/.test(status) ? 'ok' : '';
  return chip(status.length > 90 ? `${status.slice(0, 90)}…` : status, kind);
}

export const fmtDate = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '');
