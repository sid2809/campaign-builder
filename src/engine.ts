// One pass of the worker for one run (from the rsa repo's worker tick; the Sheet's boxes are now run state
// set by the dashboard's buttons).
//
// Run state keys set by the dashboard: themes (confirmed list), approved, upload_rest, enable_pilot,
// enable_rest, sync_requested, preflight ('' to try again).
import type { AppDb, RunDb } from './db.ts';
import { collectCopyBatches, submitCopyBatch, type BatchClient } from './copy.ts';
import { runGrouping } from './grouping.ts';
import { AdsError, isQuotaError, type AdsPort } from './ads.ts';
import { preflight, resolveTargets, campaignsInAccount, uploadCampaign, topUpCampaign, enableWave, sync, QuotaReached, googleQuotaExhausted } from './upload.ts';
import { DEFAULT_DAILY_CAP, SYNC_EVERY_HOURS, UPLOAD_MAX_ATTEMPTS, type Wave } from './config.ts';
import type { RunSettings } from './settings.ts';
import { log } from './log.ts';

export interface Deps {
  app: AppDb;
  batches: BatchClient;
  adsFor(customerId: string): AdsPort;
}

export const DAILY_SYNC_DAYS = 7; // the daily sync runs this long after a run's last upload; "Refresh now" always works

export async function dailyCap(app: AppDb): Promise<number> {
  const saved = Number(await app.getSetting('daily_cap'));
  return Number.isInteger(saved) && saved > 0 ? saved : DEFAULT_DAILY_CAP;
}

export async function tickRun(deps: Deps, runId: number): Promise<void> {
  const db = deps.app.forRun(runId);
  const run = await db.run();
  const settings = run.settings;

  // 1. Ad copy for every article, from the start (it doesn't depend on the grouping).
  await collectCopyBatches(db, deps.batches, settings);
  await submitCopyBatch(db, deps.batches, settings);

  // 2. Grouping. With review on, it waits for the theme list to be confirmed.
  if (!(await runGrouping(db, deps.batches, settings))) return;

  // 3. With review on, nothing goes to Google before Approve; the copy is shown once every answer is in.
  if (settings.review && (await db.get('approved')) !== '1') {
    const pending = await db.copyPending();
    if (pending > 0) await db.setStatus(`Writing ad copy: ${pending} articles to go`);
    else await db.setStatus('Waiting for you: review and approve', 'approve');
    return;
  }

  // 4. Google Ads.
  const quotaUntil = await deps.app.getSetting('google_quota_until');
  if (quotaUntil && Date.parse(quotaUntil) > Date.now()) {
    await db.setStatus(`Waiting: Google's daily API limit is used up. Resuming at ${quotaUntil}`);
    return;
  }
  const cap = await dailyCap(deps.app);
  const ads = deps.adsFor(settings.account);
  try {
    await uploads(db, ads, settings, cap);
    for (const wave of ['pilot', 'rest'] as const) {
      if ((await db.get(`enable_${wave}`)) === 'requested') {
        await enableWave(db, ads, settings, cap, wave);
        await db.set(`enable_${wave}`, 'done');
      }
    }
    await syncIfDue(db, ads, cap);
  } catch (error) {
    // Google refused a query or an enable for quota (uploads handle this themselves).
    if (error instanceof AdsError && isQuotaError(error)) error = await googleQuotaExhausted(deps.app, error, 0, runId);
    if (error instanceof QuotaReached) {
      await db.setStatus(`Waiting: ${error.message}`);
      log(`run ${runId}: ${error.message}`);
      return;
    }
    throw error;
  }
  await describe(db, settings);
}

// Which waves may be uploaded now: the pilot first; the rest after "Upload rest" (or at once when there is no pilot).
async function wavesOn(db: RunDb, settings: RunSettings): Promise<Wave[]> {
  if (settings.pilot === 0) return ['rest'];
  return (await db.get('upload_rest')) === '1' ? ['pilot', 'rest'] : ['pilot'];
}

async function uploads(db: RunDb, ads: AdsPort, settings: RunSettings, cap: number): Promise<void> {
  const waves = await wavesOn(db, settings);
  const ready: Record<string, Awaited<ReturnType<RunDb['campaignsToUpload']>>> = {};
  for (const wave of waves) ready[wave] = await db.campaignsToUpload(wave, UPLOAD_MAX_ATTEMPTS);

  // Preflight once, before the run's first upload. A failure stops the run's uploads until "Try again".
  if ((await db.get('preflight')) !== 'passed') {
    if ((await db.get('preflight')) === 'failed') return;
    if (!waves.some((w) => ready[w].length > 0)) return; // preflight checks a real campaign, so wait for its copy
    try {
      const notes = await preflight(db, ads, settings, cap);
      await db.set('preflight', 'passed');
      await db.set('preflight_notes', notes.join(' · '));
      log(`run ${db.runId}: preflight passed: ${notes.join(' · ')}`);
    } catch (error) {
      if (error instanceof QuotaReached) throw error;
      if (error instanceof AdsError && isQuotaError(error)) throw error;
      await db.set('preflight', 'failed');
      await db.set('preflight_notes', (error as Error).message);
      log(`run ${db.runId}: preflight failed: ${(error as Error).message}`);
      return;
    }
  }

  const targets = await resolveTargets(db, ads, settings, cap);
  for (const wave of waves) {
    // The rest waits until every pilot campaign is done (uploaded or failed).
    if (wave === 'rest' && (await db.campaigns('pilot')).some((c) => c.status === 'pending')) continue;
    const todo = ready[wave];
    if (todo.length === 0) continue;
    // Protects against creating a campaign twice after a crash: a campaign of this run already in the account is taken over.
    const existing = await campaignsInAccount(db, ads, cap, todo.map((c) => c.name));
    for (const campaign of todo) {
      await uploadCampaign(db, ads, settings, cap, targets, campaign.name, existing);
      await db.set('sync_requested', '1');
      await db.set('last_upload', new Date().toISOString());
    }
  }
  // Ads whose copy came after their campaign was uploaded go into the existing campaign.
  for (const wave of waves) {
    for (const campaign of await db.campaignsToTopUp(wave)) {
      await topUpCampaign(db, ads, settings, cap, campaign.name);
      await db.set('sync_requested', '1');
      await db.set('last_upload', new Date().toISOString());
    }
  }
}

async function syncIfDue(db: RunDb, ads: AdsPort, cap: number): Promise<void> {
  if (!(await db.campaigns()).some((c) => c.status === 'uploaded')) return;
  const requested = (await db.get('sync_requested')) === '1';
  const lastSync = await db.get('last_sync');
  const lastUpload = await db.get('last_upload');
  const withinDailyWindow = !lastUpload || Date.now() - Date.parse(lastUpload) < DAILY_SYNC_DAYS * 24 * 3600 * 1000;
  const dailyDue = withinDailyWindow && (!lastSync || Date.now() - Date.parse(lastSync) > SYNC_EVERY_HOURS * 3600 * 1000);
  if (!requested && !dailyDue) return;
  await sync(db, ads, cap);
  await db.set('sync_requested', '0');
}

// The run's status line, and whether the worker still has anything to do for it.
async function describe(db: RunDb, settings: RunSettings): Promise<void> {
  const state = await db.state();
  const campaigns = await db.campaigns();
  const pendingOf = (wave: Wave) => campaigns.filter((c) => c.wave === wave && c.status === 'pending').length;
  const uploaded = campaigns.filter((c) => c.status === 'uploaded');
  const notEnabled = uploaded.filter((c) => !c.enabled_at).length;
  const failed = campaigns.filter((c) => c.status === 'failed').length;
  const failedNote = failed > 0 ? `, ${failed} not created (see the report)` : '';
  const copyPending = await db.copyPending();

  if (state.preflight === 'failed') return db.setStatus(`Stopped: preflight failed: ${state.preflight_notes ?? ''}`.slice(0, 600));
  const hasPilot = settings.pilot > 0;
  if (hasPilot && pendingOf('pilot') > 0) return db.setStatus(`Uploading pilot: ${pendingOf('pilot')} campaigns to go${copyPending > 0 ? ' (waiting for ad copy)' : ''}`);
  if (hasPilot && state.upload_rest !== '1' && pendingOf('rest') > 0) {
    return db.setStatus(`Pilot uploaded (paused): ${uploaded.length} campaigns${failedNote}. Next: Enable pilot, Upload rest`);
  }
  if (pendingOf('rest') > 0) return db.setStatus(`Uploading: ${pendingOf('rest')} campaigns to go${copyPending > 0 ? ' (waiting for ad copy)' : ''}`);

  const toppingUp = (await db.campaignsToTopUp('pilot')).length + (await db.campaignsToTopUp('rest')).length;
  if (toppingUp > 0) return db.setStatus(`Adding late ads to ${toppingUp} campaigns`);
  const lastUpload = state.last_upload ? Date.parse(state.last_upload) : Date.now();
  const syncWindowOver = Date.now() - lastUpload >= DAILY_SYNC_DAYS * 24 * 3600 * 1000;
  // Nothing left for the worker once everything is uploaded and enabled and the daily sync window is over.
  await db.setFinished(notEnabled === 0 && syncWindowOver && copyPending === 0);
  if (uploaded.length === 0) return db.setStatus(`Nothing was uploaded${failedNote}`);
  if (notEnabled > 0) return db.setStatus(`Uploaded (paused): ${uploaded.length} campaigns${failedNote}. ${notEnabled} not enabled yet`);
  return db.setStatus(`Uploaded and enabled: ${uploaded.length} campaigns${failedNote}`);
}

// One pass over every run that still needs the worker. One run's error never stops the others.
export async function tickAll(deps: Deps): Promise<void> {
  const active = await deps.app.activeRuns();
  const requested = await deps.app.pool.query("SELECT run_id FROM run_state WHERE key = 'sync_requested' AND value = '1'");
  const ids = [...new Set([...active.map((r) => r.id), ...requested.rows.map((r) => r.run_id as number)])].sort((a, b) => a - b);
  for (const id of ids) {
    try {
      await tickRun(deps, id);
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      await deps.app.forRun(id).setStatus(`Error (will retry next minute): ${message.slice(0, 300)}`);
      log(`run ${id}: error: ${(error as Error).stack ?? message}`);
    }
  }
}
