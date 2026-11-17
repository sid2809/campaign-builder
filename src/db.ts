import pg from 'pg';
import { isComplete, isUsable, type AdCopy } from './adcopy.ts';
import { COPY_MAX_ATTEMPTS, MIN_DESCRIPTIONS_REQUIRED, MIN_HEADLINES_REQUIRED, type Wave } from './config.ts';
import type { RunSettings } from './settings.ts';

// State lives in Postgres, so a restart never re-creates anything.
//
// Article copy_status: pending -> (in a batch) -> done | failed
// Article ad_status:   pending -> uploaded | error (rejected by Google) | skipped (no ad copy)
// Campaign status:     pending -> uploaded | failed

const SCHEMA = `
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS domains (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  defaults JSONB NOT NULL,
  last_number INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS runs (
  id SERIAL PRIMARY KEY,
  domain_id INTEGER NOT NULL REFERENCES domains(id),
  name TEXT NOT NULL,
  settings JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'Imported',
  waiting TEXT,
  finished BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS run_state (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (run_id, key)
);
CREATE TABLE IF NOT EXISTS articles (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  row_index INTEGER NOT NULL,
  row_number INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  keywords JSONB NOT NULL,
  theme TEXT,
  topic TEXT,
  tag_attempts INTEGER NOT NULL DEFAULT 0,
  tag_batch TEXT,
  campaign TEXT NOT NULL DEFAULT '',
  ad_group TEXT NOT NULL DEFAULT '',
  wave TEXT NOT NULL DEFAULT 'rest',
  copy_status TEXT NOT NULL DEFAULT 'pending',
  copy_attempts INTEGER NOT NULL DEFAULT 0,
  batch_id TEXT,
  headlines JSONB,
  descriptions JSONB,
  copy_error TEXT,
  ad_status TEXT NOT NULL DEFAULT 'pending',
  ad_id TEXT,
  ad_group_id TEXT,
  approval TEXT,
  policy_topics TEXT,
  error TEXT,
  PRIMARY KEY (run_id, url),
  UNIQUE (run_id, row_index)
);
CREATE TABLE IF NOT EXISTS skipped_rows (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  row_number INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  keywords TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS campaigns (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  wave TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  campaign_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  enabled_at TIMESTAMPTZ,
  serving_status TEXT,
  PRIMARY KEY (run_id, name)
);
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  request_count INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ops (
  ts BIGINT NOT NULL,
  count INTEGER NOT NULL,
  kind TEXT NOT NULL,
  run_id INTEGER
);
CREATE INDEX IF NOT EXISTS ops_ts ON ops (ts);
CREATE INDEX IF NOT EXISTS articles_campaign ON articles (run_id, campaign);
`;

export interface ArticleRow {
  run_id: number;
  row_index: number;
  row_number: number; // the row in the uploaded file (2 = first row under the header)
  url: string;
  title: string;
  keywords: string[];
  theme: string | null;
  topic: string | null;
  tag_attempts: number;
  tag_batch: string | null;
  campaign: string;
  ad_group: string;
  wave: Wave;
  copy_status: 'pending' | 'done' | 'failed';
  copy_attempts: number;
  batch_id: string | null;
  headlines: string[] | null;
  descriptions: string[] | null;
  copy_error: string | null;
  ad_status: 'pending' | 'uploaded' | 'error' | 'skipped';
  ad_id: string | null;
  ad_group_id: string | null;
  approval: string | null;
  policy_topics: string | null;
  error: string | null;
}

export interface CampaignRow {
  run_id: number;
  name: string;
  position: number;
  wave: Wave;
  status: 'pending' | 'uploaded' | 'failed';
  campaign_id: string | null;
  attempts: number;
  error: string | null;
  enabled_at: Date | null;
  serving_status: string | null;
}

export interface DomainRow {
  id: number;
  name: string;
  defaults: RunSettings;
  last_number: number;
}

export interface RunRow {
  id: number;
  domain_id: number;
  name: string;
  settings: RunSettings;
  status: string;
  waiting: string | null; // null | 'themes' | 'approve'
  finished: boolean;
  created_at: Date;
}

export interface SkippedRow {
  row_number: number;
  url: string;
  title: string;
  keywords: string;
  reason: string;
}

export type BatchKind = 'copy' | 'tag' | 'themes';

type Queryable = { query: (text: string, values?: unknown[]) => Promise<pg.QueryResult<any>> };

export class AppDb {
  readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
  }

  // The dashboard and the worker both run this at start; the lock makes them take turns.
  async migrate(): Promise<void> {
    await this.tx(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(4207181)');
      await q.query(SCHEMA);
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // ---------- app settings ----------
  async getSetting(key: string): Promise<string | undefined> {
    const r = await this.pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
    return r.rows[0]?.value;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.pool.query('INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, value]);
  }

  // ---------- domains ----------
  async domains(): Promise<DomainRow[]> {
    return (await this.pool.query('SELECT * FROM domains ORDER BY name')).rows;
  }

  async domain(id: number): Promise<DomainRow | undefined> {
    return (await this.pool.query('SELECT * FROM domains WHERE id = $1', [id])).rows[0];
  }

  async createDomain(name: string, defaults: RunSettings): Promise<number> {
    const r = await this.pool.query('INSERT INTO domains (name, defaults) VALUES ($1, $2) RETURNING id', [name, JSON.stringify(defaults)]);
    return r.rows[0].id;
  }

  async updateDomain(id: number, name: string, defaults: RunSettings): Promise<void> {
    await this.pool.query('UPDATE domains SET name = $2, defaults = $3 WHERE id = $1', [id, name, JSON.stringify(defaults)]);
  }

  // ---------- runs ----------
  async runs(): Promise<(RunRow & { domain_name: string })[]> {
    return (await this.pool.query('SELECT r.*, d.name AS domain_name FROM runs r JOIN domains d ON d.id = r.domain_id ORDER BY r.id DESC')).rows;
  }

  async activeRuns(): Promise<RunRow[]> {
    return (await this.pool.query('SELECT * FROM runs WHERE NOT finished ORDER BY id')).rows;
  }

  async run(id: number): Promise<RunRow | undefined> {
    return (await this.pool.query('SELECT * FROM runs WHERE id = $1', [id])).rows[0];
  }

  // URLs of this list that are already in an earlier run (for the warning; they are still imported).
  async urlsInEarlierRuns(urls: string[]): Promise<{ url: string; run_id: number; run_name: string }[]> {
    if (urls.length === 0) return [];
    const r = await this.pool.query(
      'SELECT DISTINCT ON (a.url) a.url, a.run_id, r.name AS run_name FROM articles a JOIN runs r ON r.id = a.run_id WHERE a.url = ANY($1) ORDER BY a.url, a.run_id',
      [urls],
    );
    return r.rows;
  }

  // Creates a run with its articles and the rows that can't become an ad, in one transaction.
  async createRun(
    domainId: number,
    name: string,
    settings: RunSettings,
    articles: { rowNumber: number; url: string; title: string; keywords: string[] }[],
    skipped: SkippedRow[],
  ): Promise<number> {
    return this.tx(async (q) => {
      const runId: number = (await q.query('INSERT INTO runs (domain_id, name, settings) VALUES ($1, $2, $3) RETURNING id', [domainId, name, JSON.stringify(settings)])).rows[0].id;
      for (let i = 0; i < articles.length; i += 500) {
        const chunk = articles.slice(i, i + 500);
        await q.query(
          `INSERT INTO articles (run_id, row_index, row_number, url, title, keywords)
           SELECT $1, x.row_index, x.row_number, x.url, x.title, x.keywords::jsonb
           FROM unnest($2::int[], $3::int[], $4::text[], $5::text[], $6::text[]) AS x(row_index, row_number, url, title, keywords)`,
          [runId, chunk.map((_, n) => i + n), chunk.map((a) => a.rowNumber), chunk.map((a) => a.url), chunk.map((a) => a.title), chunk.map((a) => JSON.stringify(a.keywords))],
        );
      }
      for (const s of skipped) {
        await q.query('INSERT INTO skipped_rows (run_id, row_number, url, title, keywords, reason) VALUES ($1, $2, $3, $4, $5, $6)', [runId, s.row_number, s.url, s.title, s.keywords, s.reason]);
      }
      return runId;
    });
  }

  // ---------- API quota (shared by every run) ----------
  async addOps(count: number, kind: string, runId?: number): Promise<void> {
    if (count !== 0) await this.pool.query('INSERT INTO ops (ts, count, kind, run_id) VALUES ($1, $2, $3, $4)', [Date.now(), count, kind, runId ?? null]);
  }

  async opsLast24h(): Promise<number> {
    const r = await this.pool.query('SELECT COALESCE(SUM(count), 0)::int AS n FROM ops WHERE ts > $1', [Date.now() - 24 * 3600 * 1000]);
    return r.rows[0].n;
  }

  forRun(runId: number): RunDb {
    return new RunDb(this, runId);
  }
}

// Everything the engine reads and writes for one run.
export class RunDb {
  readonly app: AppDb;
  readonly runId: number;
  private readonly pool: pg.Pool;

  constructor(app: AppDb, runId: number) {
    this.app = app;
    this.runId = runId;
    this.pool = app.pool;
  }

  private async rows<T = any>(text: string, values: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(text, [this.runId, ...values])).rows;
  }

  private async changed(text: string, values: unknown[] = []): Promise<number> {
    return (await this.pool.query(text, [this.runId, ...values])).rowCount ?? 0;
  }

  // ---------- run ----------
  async run(): Promise<RunRow> {
    const run = await this.app.run(this.runId);
    if (!run) throw new Error(`run ${this.runId} not found`);
    return run;
  }

  async setStatus(status: string, waiting: string | null = null): Promise<void> {
    await this.pool.query('UPDATE runs SET status = $2, waiting = $3 WHERE id = $1', [this.runId, status, waiting]);
  }

  async setFinished(finished: boolean): Promise<void> {
    await this.pool.query('UPDATE runs SET finished = $2 WHERE id = $1', [this.runId, finished]);
  }

  // ---------- key/value ----------
  async get(key: string): Promise<string | undefined> {
    return (await this.rows<{ value: string }>('SELECT value FROM run_state WHERE run_id = $1 AND key = $2', [key]))[0]?.value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.pool.query('INSERT INTO run_state (run_id, key, value) VALUES ($1, $2, $3) ON CONFLICT (run_id, key) DO UPDATE SET value = EXCLUDED.value', [this.runId, key, value]);
  }

  async state(): Promise<Record<string, string>> {
    const rows = await this.rows<{ key: string; value: string }>('SELECT key, value FROM run_state WHERE run_id = $1');
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  // ---------- articles ----------
  async allArticles(): Promise<ArticleRow[]> {
    return this.rows('SELECT * FROM articles WHERE run_id = $1 ORDER BY row_index');
  }

  async article(url: string): Promise<ArticleRow | undefined> {
    return (await this.rows('SELECT * FROM articles WHERE run_id = $1 AND url = $2', [url]))[0];
  }

  async articleByIndex(index: number): Promise<ArticleRow | undefined> {
    return (await this.rows('SELECT * FROM articles WHERE run_id = $1 AND row_index = $2', [index]))[0];
  }

  async articlesOf(campaign: string): Promise<ArticleRow[]> {
    return this.rows('SELECT * FROM articles WHERE run_id = $1 AND campaign = $2 ORDER BY row_index', [campaign]);
  }

  async skippedRows(): Promise<SkippedRow[]> {
    return this.rows('SELECT row_number, url, title, keywords, reason FROM skipped_rows WHERE run_id = $1 ORDER BY row_number');
  }

  // ---------- batches ----------
  async openBatches(kind: BatchKind): Promise<string[]> {
    return (await this.rows<{ id: string }>("SELECT id FROM batches WHERE run_id = $1 AND status = 'open' AND kind = $2 ORDER BY created_at, id", [kind])).map((r) => r.id);
  }

  async addBatch(id: string, kind: BatchKind, requestCount: number): Promise<void> {
    await this.pool.query('INSERT INTO batches (id, run_id, kind, request_count) VALUES ($1, $2, $3, $4)', [id, this.runId, kind, requestCount]);
  }

  async closeBatchRecord(id: string): Promise<void> {
    await this.pool.query("UPDATE batches SET status = 'closed' WHERE id = $1 AND run_id = $2", [id, this.runId]);
  }

  // ---------- ad copy ----------
  async articlesNeedingCopy(maxAttempts: number): Promise<ArticleRow[]> {
    return this.rows("SELECT * FROM articles WHERE run_id = $1 AND copy_status = 'pending' AND batch_id IS NULL AND copy_attempts < $2 ORDER BY row_index", [maxAttempts]);
  }

  // The batch is saved together with its articles, so a restart polls it instead of sending a new one.
  async addCopyBatch(id: string, urls: string[]): Promise<void> {
    await this.app.tx(async (q) => {
      await q.query("INSERT INTO batches (id, run_id, kind, request_count) VALUES ($1, $2, 'copy', $3)", [id, this.runId, urls.length]);
      await q.query('UPDATE articles SET batch_id = $2 WHERE run_id = $1 AND url = ANY($3)', [this.runId, id, urls]);
    });
  }

  async closeCopyBatch(id: string): Promise<void> {
    await this.closeBatchRecord(id);
    // Anything in the batch without a result goes back in the queue (counts as an attempt).
    await this.changed(
      `UPDATE articles SET batch_id = NULL, copy_attempts = copy_attempts + 1, copy_error = COALESCE(copy_error, 'no result in batch')
       WHERE run_id = $1 AND batch_id = $2 AND copy_status = 'pending'`,
      [id],
    );
    // An article left pending with no tries left: usable copy from an earlier try is kept, otherwise it has failed.
    await this.changed(
      `UPDATE articles SET copy_status = CASE WHEN headlines IS NOT NULL AND jsonb_array_length(headlines) >= $3 AND jsonb_array_length(COALESCE(descriptions, '[]'::jsonb)) >= $4
                                           THEN 'done' ELSE 'failed' END
       WHERE run_id = $1 AND copy_status = 'pending' AND batch_id IS NULL AND copy_attempts >= $2`,
      [COPY_MAX_ATTEMPTS, MIN_HEADLINES_REQUIRED, MIN_DESCRIPTIONS_REQUIRED],
    );
  }

  // Records one Claude answer. Keeps the best copy seen so far.
  // Done when the copy is complete (15 + 4), or after the last attempt if the best copy is still usable (3 + 2).
  async recordCopy(url: string, copy: AdCopy | undefined, error: string | null, maxAttempts: number): Promise<void> {
    const row = await this.article(url);
    if (!row || row.copy_status !== 'pending') return;
    const attempts = row.copy_attempts + 1;
    const previous: AdCopy | undefined = row.headlines ? { headlines: row.headlines, descriptions: row.descriptions ?? [] } : undefined;
    const size = (c: AdCopy) => c.headlines.length + c.descriptions.length;
    const best = copy && (!previous || size(copy) > size(previous)) ? copy : previous;
    let status: ArticleRow['copy_status'] = 'pending';
    if (best && isComplete(best)) status = 'done';
    else if (attempts >= maxAttempts) status = best && isUsable(best) ? 'done' : 'failed';
    await this.changed('UPDATE articles SET copy_attempts = $3, batch_id = NULL, copy_status = $4, headlines = $5, descriptions = $6, copy_error = $7 WHERE run_id = $1 AND url = $2', [
      url,
      attempts,
      status,
      best ? JSON.stringify(best.headlines) : null,
      best ? JSON.stringify(best.descriptions) : null,
      status === 'done' ? null : error,
    ]);
  }

  async copyPending(): Promise<number> {
    return (await this.rows<{ n: number }>("SELECT COUNT(*)::int AS n FROM articles WHERE run_id = $1 AND copy_status = 'pending'"))[0].n;
  }

  // ---------- grouping ----------
  async articlesNeedingTag(maxAttempts: number): Promise<ArticleRow[]> {
    return this.rows('SELECT * FROM articles WHERE run_id = $1 AND theme IS NULL AND tag_batch IS NULL AND tag_attempts < $2 ORDER BY row_index', [maxAttempts]);
  }

  // The tag batch is saved together with its articles (the rsa bug of 15 Nov 2026 was a batch sent but not recorded).
  async addTagBatch(id: string, urls: string[]): Promise<void> {
    await this.app.tx(async (q) => {
      await q.query("INSERT INTO batches (id, run_id, kind, request_count) VALUES ($1, $2, 'tag', $3)", [id, this.runId, urls.length]);
      await q.query('UPDATE articles SET tag_batch = $2 WHERE run_id = $1 AND url = ANY($3)', [this.runId, id, urls]);
    });
  }

  async recordTag(url: string, theme: string | null, topic: string | null): Promise<void> {
    if (theme) await this.changed('UPDATE articles SET theme = $3, topic = $4, tag_batch = NULL WHERE run_id = $1 AND url = $2', [url, theme, topic]);
    else await this.changed('UPDATE articles SET tag_attempts = tag_attempts + 1, tag_batch = NULL WHERE run_id = $1 AND url = $2', [url]);
  }

  // Articles still in a closed tag batch without a result go back in the queue.
  async releaseTagBatch(id: string): Promise<void> {
    await this.changed('UPDATE articles SET tag_batch = NULL, tag_attempts = tag_attempts + 1 WHERE run_id = $1 AND tag_batch = $2 AND theme IS NULL', [id]);
  }

  // Articles Haiku couldn't tag after every try go to the last theme ("Other"), grouped by their first keyword.
  async tagLeftovers(theme: string): Promise<number> {
    return this.changed("UPDATE articles SET theme = $2, topic = lower(keywords->>0) WHERE run_id = $1 AND theme IS NULL", [theme]);
  }

  async saveGrouping(assignments: { url: string; campaign: string; adGroup: string; wave: Wave }[], campaigns: { name: string; wave: Wave }[]): Promise<void> {
    await this.app.tx(async (q) => {
      for (let i = 0; i < assignments.length; i += 500) {
        const chunk = assignments.slice(i, i + 500);
        await q.query(
          `UPDATE articles a SET campaign = x.campaign, ad_group = x.ad_group, wave = x.wave
           FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS x(url, campaign, ad_group, wave)
           WHERE a.run_id = $1 AND a.url = x.url`,
          [this.runId, chunk.map((a) => a.url), chunk.map((a) => a.campaign), chunk.map((a) => a.adGroup), chunk.map((a) => a.wave)],
        );
      }
      await q.query(
        `INSERT INTO campaigns (run_id, name, position, wave)
         SELECT $1, x.name, x.position, x.wave FROM unnest($2::text[], $3::int[], $4::text[]) AS x(name, position, wave)`,
        [this.runId, campaigns.map((c) => c.name), campaigns.map((_, i) => i), campaigns.map((c) => c.wave)],
      );
    });
  }

  // "Continue" numbering: reserves `count` numbers after the domain's last one. Returns the first number.
  async reserveNumbers(count: number): Promise<number> {
    const r = await this.pool.query('UPDATE domains d SET last_number = d.last_number + $2 FROM runs r WHERE r.id = $1 AND d.id = r.domain_id RETURNING d.last_number', [this.runId, count]);
    return r.rows[0].last_number - count + 1;
  }

  // ---------- campaigns ----------
  async campaigns(wave?: Wave): Promise<CampaignRow[]> {
    if (wave) return this.rows('SELECT * FROM campaigns WHERE run_id = $1 AND wave = $2 ORDER BY position', [wave]);
    return this.rows('SELECT * FROM campaigns WHERE run_id = $1 ORDER BY position');
  }

  async campaign(name: string): Promise<CampaignRow | undefined> {
    return (await this.rows('SELECT * FROM campaigns WHERE run_id = $1 AND name = $2', [name]))[0];
  }

  // Campaigns ready to be created: still pending, tries left, and every article has its copy answer.
  async campaignsToUpload(wave: Wave, maxAttempts: number): Promise<CampaignRow[]> {
    return this.rows(
      `SELECT c.* FROM campaigns c WHERE c.run_id = $1 AND c.wave = $2 AND c.status = 'pending' AND c.attempts < $3
       AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.run_id = c.run_id AND a.campaign = c.name AND a.copy_status = 'pending')
       ORDER BY c.position`,
      [wave, maxAttempts],
    );
  }

  // Uploaded campaigns that have articles with copy now but no ad yet (their copy came after the upload).
  async campaignsToTopUp(wave: Wave): Promise<CampaignRow[]> {
    return this.rows(
      `SELECT c.* FROM campaigns c WHERE c.run_id = $1 AND c.wave = $2 AND c.status = 'uploaded' AND c.campaign_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM articles a WHERE a.run_id = c.run_id AND a.campaign = c.name AND a.ad_status = 'skipped' AND a.copy_status = 'done')
       ORDER BY c.position`,
      [wave],
    );
  }

  // `note` on an uploaded ad records what Google left out of it (rejected keywords); it goes in the report.
  async markCampaignUploaded(
    name: string,
    campaignId: string,
    ads: { url: string; adGroupId: string; adId: string; note?: string | null }[],
    leftOut: { url: string; status: 'error' | 'skipped'; error: string }[],
  ): Promise<void> {
    await this.app.tx(async (q) => {
      await q.query("UPDATE campaigns SET status = 'uploaded', campaign_id = $3, error = NULL WHERE run_id = $1 AND name = $2", [this.runId, name, campaignId]);
      for (const ad of ads) {
        await q.query("UPDATE articles SET ad_status = 'uploaded', ad_group_id = $3, ad_id = $4, error = $5 WHERE run_id = $1 AND url = $2", [this.runId, ad.url, ad.adGroupId, ad.adId, ad.note ?? null]);
      }
      for (const item of leftOut) await q.query('UPDATE articles SET ad_status = $3, error = $4 WHERE run_id = $1 AND url = $2', [this.runId, item.url, item.status, item.error]);
    });
  }

  // Nothing of the campaign could be sent (no ad copy, or everything rejected): it is not created, and each article is reported.
  async markCampaignUploadedNothing(name: string, leftOut: { url: string; status: 'error' | 'skipped'; error: string }[]): Promise<void> {
    await this.app.tx(async (q) => {
      await q.query("UPDATE campaigns SET status = 'failed', error = 'no article could be uploaded' WHERE run_id = $1 AND name = $2", [this.runId, name]);
      for (const item of leftOut) await q.query('UPDATE articles SET ad_status = $3, error = $4 WHERE run_id = $1 AND url = $2', [this.runId, item.url, item.status, item.error]);
    });
  }

  async markAdsAdded(ads: { url: string; adGroupId: string; adId: string }[], leftOut: { url: string; error: string }[]): Promise<void> {
    await this.app.tx(async (q) => {
      for (const ad of ads) await q.query("UPDATE articles SET ad_status = 'uploaded', ad_group_id = $3, ad_id = $4, error = NULL WHERE run_id = $1 AND url = $2", [this.runId, ad.url, ad.adGroupId, ad.adId]);
      for (const item of leftOut) await q.query("UPDATE articles SET ad_status = 'error', error = $3 WHERE run_id = $1 AND url = $2", [this.runId, item.url, item.error]);
    });
  }

  // A failed campaign's articles are reported with the campaign's error.
  async markCampaignAttemptFailed(name: string, error: string, maxAttempts: number): Promise<void> {
    const row = await this.campaign(name);
    if (!row) return;
    const attempts = row.attempts + 1;
    const failed = attempts >= maxAttempts;
    await this.changed('UPDATE campaigns SET attempts = $3, error = $4, status = $5 WHERE run_id = $1 AND name = $2', [name, attempts, error, failed ? 'failed' : 'pending']);
    if (failed) await this.changed("UPDATE articles SET ad_status = 'error', error = COALESCE(error, $3) WHERE run_id = $1 AND campaign = $2 AND ad_status = 'pending'", [name, `campaign not created: ${error}`]);
  }

  // Records an error on a campaign without using one of its tries (temporary errors).
  async noteCampaignError(name: string, error: string): Promise<void> {
    await this.changed('UPDATE campaigns SET error = $3 WHERE run_id = $1 AND name = $2', [name, error]);
  }

  async markEnabled(name: string): Promise<void> {
    await this.changed('UPDATE campaigns SET enabled_at = now() WHERE run_id = $1 AND name = $2', [name]);
  }

  async setCampaignServing(campaignId: string, status: string): Promise<void> {
    await this.changed('UPDATE campaigns SET serving_status = $3 WHERE run_id = $1 AND campaign_id = $2', [campaignId, status]);
  }

  async setAdApproval(adId: string, approval: string, topics: string): Promise<void> {
    await this.changed('UPDATE articles SET approval = $3, policy_topics = $4 WHERE run_id = $1 AND ad_id = $2', [adId, approval, topics]);
  }

  // ---------- counts for the dashboard ----------
  async adsPerCampaign(): Promise<Map<string, number>> {
    const rows = await this.rows<{ campaign: string; n: number }>("SELECT campaign, COUNT(*)::int AS n FROM articles WHERE run_id = $1 AND ad_status = 'uploaded' GROUP BY campaign");
    return new Map(rows.map((r) => [r.campaign, r.n]));
  }

  async counts(): Promise<Record<string, number>> {
    const [a] = await this.rows<Record<string, number>>(
      `SELECT COUNT(*)::int AS articles,
              COUNT(*) FILTER (WHERE theme IS NOT NULL)::int AS tagged,
              COUNT(*) FILTER (WHERE copy_status = 'done')::int AS copy_done,
              COUNT(*) FILTER (WHERE copy_status = 'failed')::int AS copy_failed,
              COUNT(*) FILTER (WHERE ad_status = 'uploaded')::int AS ads_uploaded,
              COUNT(*) FILTER (WHERE ad_status = 'error')::int AS ads_rejected,
              COUNT(*) FILTER (WHERE ad_status = 'skipped')::int AS ads_no_copy,
              COUNT(*) FILTER (WHERE approval LIKE 'APPROVED%')::int AS approved,
              COUNT(*) FILTER (WHERE approval LIKE 'DISAPPROVED%')::int AS disapproved
       FROM articles WHERE run_id = $1`,
    );
    const [c] = await this.rows<Record<string, number>>(
      `SELECT COUNT(*)::int AS campaigns,
              COUNT(*) FILTER (WHERE status = 'uploaded')::int AS campaigns_uploaded,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS campaigns_failed,
              COUNT(*) FILTER (WHERE enabled_at IS NOT NULL)::int AS campaigns_enabled,
              COUNT(*) FILTER (WHERE wave = 'pilot')::int AS pilot_campaigns
       FROM campaigns WHERE run_id = $1`,
    );
    const [s] = await this.rows<Record<string, number>>('SELECT COUNT(*)::int AS skipped FROM skipped_rows WHERE run_id = $1');
    return { ...a, ...c, ...s };
  }
}
