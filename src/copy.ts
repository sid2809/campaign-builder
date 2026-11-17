import Anthropic from '@anthropic-ai/sdk';
import type { RunDb } from './db.ts';
import { systemPrompt, AD_COPY_SCHEMA, userMessage, parseAdCopy, salvageAdCopy } from './adcopy.ts';
import { COPY_MAX_ATTEMPTS, COPY_MAX_TOKENS, KITCHEN_COPY_RULES } from './config.ts';
import type { RunSettings } from './settings.ts';
import { log } from './log.ts';

// The parts of the Anthropic client the app uses (tests pass a fake).
export interface BatchClient {
  create(requests: BatchRequest[]): Promise<{ id: string }>;
  status(id: string): Promise<{ ended: boolean; counts: Record<string, number> }>;
  results(id: string): AsyncIterable<BatchResult>;
}

export interface BatchRequest {
  custom_id: string;
  params: Record<string, unknown>;
}

export interface BatchResult {
  custom_id: string;
  type: 'succeeded' | 'errored' | 'canceled' | 'expired';
  text?: string; // the answer's text, when succeeded
  stopReason?: string | null;
  error?: string;
}

export function anthropicBatchClient(apiKey: string): BatchClient {
  const client = new Anthropic({ apiKey, maxRetries: 6 });
  return {
    async create(requests) {
      const batch = await client.messages.batches.create({ requests: requests as never });
      return { id: batch.id };
    },
    async status(id) {
      const batch = await client.messages.batches.retrieve(id);
      return { ended: batch.processing_status === 'ended', counts: { ...batch.request_counts } };
    },
    async *results(id) {
      for await (const entry of await client.messages.batches.results(id)) {
        const result = entry.result;
        if (result.type === 'succeeded') {
          const text = result.message.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('');
          yield { custom_id: entry.custom_id, type: 'succeeded', text, stopReason: result.message.stop_reason };
        } else if (result.type === 'errored') {
          yield { custom_id: entry.custom_id, type: 'errored', error: JSON.stringify(result.error).slice(0, 300) };
        } else {
          yield { custom_id: entry.custom_id, type: result.type };
        }
      }
    },
  };
}

// A run with an empty instructions box uses the default rules (and their banned-word filter).
export const usesDefaultRules = (settings: RunSettings) => settings.copyRules.trim() === '';
export const copyRulesOf = (settings: RunSettings) => (usesDefaultRules(settings) ? KITCHEN_COPY_RULES : settings.copyRules);

export function buildRequest(article: { row_index: number; title: string; keywords: string[]; url: string }, settings: RunSettings): BatchRequest {
  return {
    custom_id: `a${article.row_index}`,
    params: {
      model: settings.model,
      max_tokens: COPY_MAX_TOKENS,
      system: systemPrompt(copyRulesOf(settings)),
      output_config: { format: { type: 'json_schema', schema: AD_COPY_SCHEMA } },
      messages: [{ role: 'user', content: userMessage(article) }],
    },
  };
}

// Sends one batch with every article of the run that still needs copy (none already in a batch).
export async function submitCopyBatch(db: RunDb, client: BatchClient, settings: RunSettings): Promise<void> {
  const todo = await db.articlesNeedingCopy(COPY_MAX_ATTEMPTS);
  if (todo.length === 0) return;
  const { id } = await client.create(todo.map((a) => buildRequest(a, settings)));
  await db.addCopyBatch(id, todo.map((a) => a.url));
  log(`run ${db.runId}: ad copy batch ${id} sent with ${todo.length} articles`);
}

// Checks every open batch; when one has ended, stores its results.
export async function collectCopyBatches(db: RunDb, client: BatchClient, settings: RunSettings): Promise<void> {
  const dropClickbait = usesDefaultRules(settings);
  for (const id of await db.openBatches('copy')) {
    const status = await client.status(id);
    if (!status.ended) {
      log(`run ${db.runId}: ad copy batch ${id} still running ${JSON.stringify(status.counts)}`);
      continue;
    }
    let ok = 0;
    let retry = 0;
    let bad = 0;
    let salvaged = 0;
    for await (const result of client.results(id)) {
      const index = Number(result.custom_id.slice(1));
      const article = await db.articleByIndex(index);
      if (!article || article.batch_id !== id) continue;
      if (result.type !== 'succeeded') {
        await db.recordCopy(article.url, undefined, `batch result ${result.type}${result.error ? `: ${result.error}` : ''}`, COPY_MAX_ATTEMPTS);
        retry++;
        continue;
      }
      if (result.stopReason === 'refusal') {
        await db.recordCopy(article.url, undefined, 'Claude refused', COPY_MAX_ATTEMPTS);
        retry++;
        continue;
      }
      const parsed = parseAdCopy(result.text ?? '', dropClickbait);
      // A cut-off answer isn't valid JSON; keep the complete lines it has.
      const rescued = parsed ? undefined : salvageAdCopy(result.text ?? '', dropClickbait);
      const copy = parsed ?? rescued;
      // When an answer can't be used, keep why and how it started, so the report shows what the model returned.
      const snippet = (result.text ?? '').replace(/\s+/g, ' ').slice(0, 150);
      const error = copy
        ? `only ${copy.headlines.length} headlines / ${copy.descriptions.length} descriptions passed the checks${rescued ? ` (answer cut off, stop_reason ${result.stopReason ?? 'unknown'})` : ''}`
        : `answer was not valid JSON (stop_reason ${result.stopReason ?? 'unknown'}): ${snippet}`;
      if (!parsed) bad++;
      if (rescued) salvaged++;
      await db.recordCopy(article.url, copy, error, COPY_MAX_ATTEMPTS);
      ok++;
    }
    await db.closeCopyBatch(id);
    log(`run ${db.runId}: ad copy batch ${id} ended: ${ok} answers (${bad} not readable as JSON, lines kept from ${salvaged} of them), ${retry} errors`);
  }
}
