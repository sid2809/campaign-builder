// Grouping by Haiku (from the rsa repo's Kitchen grouping, made niche-neutral and sized by the run's settings).
//
// 1. Themes: one request with every article's first keyword; the model returns a list of themes (campaign level).
//    With review on, the run waits here until the list is confirmed (and possibly edited) in the dashboard.
// 2. Tags:   one request per article; the model picks one theme from that list and names the specific topic.
// 3. Code:   articles with the same topic go together, N per ad group, M ad groups per campaign,
//            never mixing themes. Campaign names come from the run's name pattern.
import type { RunDb, ArticleRow } from './db.ts';
import type { BatchClient, BatchRequest } from './copy.ts';
import type { Wave } from './config.ts';
import { campaignName, type RunSettings } from './settings.ts';
import { log } from './log.ts';

export const TAG_MAX_ATTEMPTS = 3;
export const THEMES_MAX_ATTEMPTS = 3;
export const MAX_THEME_LENGTH = 30;
export const MAX_THEMES = 60;
export const OTHER_THEME = 'Other';

// Enough themes that each can fill at least one campaign, never more than 60.
export function themeLimit(articleCount: number, settings: RunSettings): number {
  return Math.max(1, Math.min(MAX_THEMES, Math.ceil(articleCount / (settings.adsPerAdGroup * settings.adGroupsPerCampaign))));
}

const themesPrompt = (limit: number) => `You organise a website's articles into Google Ads search campaigns.
You get every article's main search keyword. Return a list of themes that together cover all of them.

Rules:
- At most ${limit} themes; use fewer when fewer cover the list well. Each theme becomes the name of one or more campaigns, so it must be a short, plain name of 1 to 3 words, at most ${MAX_THEME_LENGTH} characters, Title Case.
- Group by what the searcher wants: the main subject of the search. Articles about the same subject must fit the same theme.
- Themes must not overlap: every keyword should clearly belong to exactly one theme.
- Include "${OTHER_THEME}" for keywords that fit nothing else.`;

const TAG_PROMPT = `You tag one article of a website for Google Ads grouping.
Return:
- theme: exactly one theme from the given list, the one the searcher's intent belongs to.
- topic: the specific subject of the article, 1 to 4 lowercase words. Articles about the same thing must get the same topic, so use the plain common name, singular, without filler words like "best", "easy", "guide" or "how to".`;

export function themesRequest(keywords: string[], limit: number, model: string): BatchRequest {
  return {
    custom_id: 'themes',
    params: {
      model,
      max_tokens: 4000,
      system: themesPrompt(limit),
      output_config: {
        format: {
          type: 'json_schema',
          schema: { type: 'object', properties: { themes: { type: 'array', items: { type: 'string' } } }, required: ['themes'], additionalProperties: false },
        },
      },
      messages: [{ role: 'user', content: `Keywords (one per line):\n${keywords.join('\n')}` }],
    },
  };
}

export function tagRequest(article: { row_index: number; title: string; keywords: string[] }, themes: string[], model: string): BatchRequest {
  return {
    custom_id: `t${article.row_index}`,
    params: {
      model,
      max_tokens: 300,
      system: TAG_PROMPT,
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { theme: { type: 'string', enum: themes }, topic: { type: 'string' } },
            required: ['theme', 'topic'],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: 'user', content: `Themes: ${themes.join(' | ')}\n\nArticle title: ${article.title}\nSearch keywords: ${article.keywords.join(', ')}` }],
    },
  };
}

function parseJson(text: string): any {
  const candidates = [text.trim()];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // next
    }
  }
  return undefined;
}

const titleCase = (s: string) => s.replace(/\s+/g, ' ').trim().split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');

// Cleans a theme list (the model's, or the one typed at confirmation): short, unique, "Other" always present and last.
export function cleanThemes(raw: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(raw) ? raw : []) {
    if (typeof t !== 'string') continue;
    const name = titleCase(t.replace(/[|{}]/g, ' '));
    const key = name.toLowerCase();
    if (!name || name.length > MAX_THEME_LENGTH || seen.has(key) || key === OTHER_THEME.toLowerCase()) continue;
    seen.add(key);
    out.push(name);
  }
  return [...out.slice(0, 80), OTHER_THEME];
}

// One pass of the grouping step. Returns true once the grouping is saved.
export async function runGrouping(db: RunDb, client: BatchClient, settings: RunSettings): Promise<boolean> {
  if ((await db.get('grouped')) === '1') return true;

  // 1. Themes: proposed by the model, then confirmed (by the user with review on, automatically without).
  let themes: string[] | undefined = (await db.get('themes')) ? JSON.parse((await db.get('themes'))!) : undefined;
  if (!themes) {
    let proposed: string[] | undefined = (await db.get('themes_proposed')) ? JSON.parse((await db.get('themes_proposed'))!) : undefined;
    if (!proposed) {
      for (const id of await db.openBatches('themes')) {
        const status = await client.status(id);
        if (!status.ended) {
          log(`run ${db.runId}: theme batch ${id} still running`);
          return false;
        }
        let found: string[] | undefined;
        for await (const r of client.results(id)) {
          if (r.type === 'succeeded') {
            const list = cleanThemes(parseJson(r.text ?? '')?.themes);
            if (list.length >= 2) found = list;
          }
        }
        await db.closeBatchRecord(id);
        if (found) {
          await db.set('themes_proposed', JSON.stringify(found));
          proposed = found;
          log(`run ${db.runId}: ${found.length} themes proposed: ${found.join(', ')}`);
        } else {
          await db.set('theme_attempts', String(Number((await db.get('theme_attempts')) ?? '0') + 1));
          log(`run ${db.runId}: theme list answer was not usable`);
        }
      }
    }
    if (!proposed) {
      if ((await db.openBatches('themes')).length > 0) return false;
      if (Number((await db.get('theme_attempts')) ?? '0') >= THEMES_MAX_ATTEMPTS) {
        await db.setStatus('Stopped: the model did not return a usable theme list after 3 tries');
        return false;
      }
      const articles = await db.allArticles();
      const { id } = await client.create([themesRequest(articles.map((a) => a.keywords[0]), themeLimit(articles.length, settings), settings.model)]);
      await db.addBatch(id, 'themes', 1);
      await db.setStatus('Grouping: asking for the theme list');
      log(`run ${db.runId}: theme batch ${id} sent (${articles.length} keywords)`);
      return false;
    }
    if (settings.review) {
      await db.setStatus(`Waiting for you: confirm the ${proposed.length} themes`, 'themes');
      return false;
    }
    await db.set('themes', JSON.stringify(proposed));
    themes = proposed;
  }

  // 2. Tags
  const allowed = new Set(themes);
  for (const id of await db.openBatches('tag')) {
    const status = await client.status(id);
    if (!status.ended) {
      log(`run ${db.runId}: tag batch ${id} still running ${JSON.stringify(status.counts)}`);
      continue;
    }
    let ok = 0;
    for await (const r of client.results(id)) {
      const article = await db.articleByIndex(Number(r.custom_id.slice(1)));
      if (!article || article.tag_batch !== id) continue;
      const value = r.type === 'succeeded' ? parseJson(r.text ?? '') : undefined;
      const theme = typeof value?.theme === 'string' && allowed.has(value.theme) ? value.theme : null;
      const topic = typeof value?.topic === 'string' && value.topic.trim() ? value.topic.trim().toLowerCase().slice(0, 60) : article.keywords[0].toLowerCase();
      await db.recordTag(article.url, theme, theme ? topic : null);
      if (theme) ok++;
    }
    await db.releaseTagBatch(id);
    await db.closeBatchRecord(id);
    log(`run ${db.runId}: tag batch ${id} ended: ${ok} tagged`);
  }
  if ((await db.openBatches('tag')).length > 0) return false;
  const todo = await db.articlesNeedingTag(TAG_MAX_ATTEMPTS);
  if (todo.length > 0) {
    const { id } = await client.create(todo.map((a) => tagRequest(a, themes!, settings.model)));
    await db.addTagBatch(id, todo.map((a) => a.url));
    await db.setStatus(`Grouping: tagging ${todo.length} articles`);
    log(`run ${db.runId}: tag batch ${id} sent with ${todo.length} articles`);
    return false;
  }
  const leftovers = await db.tagLeftovers(OTHER_THEME);
  if (leftovers > 0) log(`run ${db.runId}: ${leftovers} articles could not be tagged; put in "${OTHER_THEME}"`);

  // 3. Build and save
  const articles = await db.allArticles();
  const shape = buildGrouping(articles, settings, 1);
  const first = settings.numbering === 'continue' ? await db.reserveNumbers(shape.campaigns.length) : 1;
  const { assignments, campaigns } = first === 1 ? shape : buildGrouping(articles, settings, first);
  await db.saveGrouping(assignments, campaigns);
  await db.set('grouped', '1');
  const adGroups = new Set(assignments.map((a) => `${a.campaign}\u0000${a.adGroup}`)).size;
  log(`run ${db.runId}: grouping done: ${campaigns.length} campaigns, ${adGroups} ad groups, ${assignments.length} articles`);
  return true;
}

export interface Grouping {
  assignments: { url: string; campaign: string; adGroup: string; wave: Wave }[];
  campaigns: { name: string; wave: Wave }[]; // in order
}

// Builds ad groups and campaigns from tagged articles. Pure; exported for tests.
export function buildGrouping(articles: Pick<ArticleRow, 'url' | 'keywords' | 'theme' | 'topic'>[], settings: RunSettings, firstNumber: number): Grouping {
  const perGroup = settings.adsPerAdGroup;
  const perCampaign = settings.adGroupsPerCampaign;
  const topicOf = (a: (typeof articles)[number]) => (a.topic || a.keywords[0]).toLowerCase();
  const byTheme = new Map<string, typeof articles>();
  for (const a of articles) {
    const theme = a.theme || OTHER_THEME;
    byTheme.set(theme, [...(byTheme.get(theme) ?? []), a]);
  }
  const themes = [...byTheme.keys()].sort((x, y) => (x === OTHER_THEME ? 1 : y === OTHER_THEME ? -1 : x.localeCompare(y)));

  const assignments: Grouping['assignments'] = [];
  const campaigns: { name: string; theme: string; indexInTheme: number }[] = [];
  let number = firstNumber;
  for (const theme of themes) {
    // Same topic together: full groups first, then the remainders, sorted so near topics sit together.
    const byTopic = new Map<string, typeof articles>();
    for (const a of byTheme.get(theme)!) byTopic.set(topicOf(a), [...(byTopic.get(topicOf(a)) ?? []), a]);
    const groups: (typeof articles)[] = [];
    const rest: typeof articles = [];
    for (const topic of [...byTopic.keys()].sort()) {
      const list = byTopic.get(topic)!.sort((x, y) => x.keywords[0].localeCompare(y.keywords[0]) || x.url.localeCompare(y.url));
      let i = 0;
      for (; i + perGroup <= list.length; i += perGroup) groups.push(list.slice(i, i + perGroup));
      rest.push(...list.slice(i));
    }
    for (let i = 0; i < rest.length; i += perGroup) groups.push(rest.slice(i, i + perGroup));

    for (let g = 0; g < groups.length; g += perCampaign) {
      const name = campaignName(settings.namePattern, theme, number++);
      campaigns.push({ name, theme, indexInTheme: g / perCampaign });
      const used = new Set<string>();
      for (const group of groups.slice(g, g + perCampaign)) {
        // Ad group name: the most common topic in the group; unique within the campaign.
        const counts = new Map<string, number>();
        for (const a of group) counts.set(topicOf(a), (counts.get(topicOf(a)) ?? 0) + 1);
        const base = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0][0];
        let adGroup = base;
        for (let n = 2; used.has(adGroup); n++) adGroup = `${base} ${n}`;
        used.add(adGroup);
        for (const a of group) assignments.push({ url: a.url, campaign: name, adGroup, wave: 'rest' });
      }
    }
  }

  // Pilot: the run's number of campaigns, spread over the themes (each theme's first campaign, then each
  // theme's second, and so on) so the pilot shows as many themes as it can.
  const pilot = new Set(
    [...campaigns]
      .sort((x, y) => x.indexInTheme - y.indexInTheme)
      .slice(0, Math.max(0, settings.pilot))
      .map((c) => c.name),
  );
  for (const a of assignments) if (pilot.has(a.campaign)) a.wave = 'pilot';
  return { assignments, campaigns: campaigns.map((c) => ({ name: c.name, wave: pilot.has(c.name) ? 'pilot' : 'rest' })) };
}
