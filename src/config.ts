// Fixed rules of the app. Everything a run can change lives in settings.ts.

// Google Search only: no search partners, no Display Network.
export const NETWORKS = {
  target_google_search: true,
  target_search_network: false,
  target_partner_search_network: false,
  target_content_network: false,
};

// The tracking suffix used by the rsa repo (Faith and Kitchen). Google fills the {braces} at click time.
// Stored as the app setting "final_url_suffix"; an empty setting means campaigns get no suffix.
export const RSA_FINAL_URL_SUFFIX = [
  'utm_source=google',
  'utm_medium=cpc',
  'utm_campaign={campaignid}',
  'adgroup={adgroupid}',
  'utm_content={creative}',
  'utm_term={keyword}',
  'matchtype={matchtype}',
  'targetid={targetid}',
  'network={network}',
  'device={device}',
  'loc={loc_physical_ms}',
  'loc_int={loc_interest_ms}',
  'adpos={adposition}',
].join('&');

// Responsive search ads: always 15 headlines and 4 descriptions asked for; Google's minimum is 3 and 2.
export const HEADLINES_WANTED = 15;
export const DESCRIPTIONS_WANTED = 4;
export const MIN_HEADLINES_REQUIRED = 3;
export const MIN_DESCRIPTIONS_REQUIRED = 2;
export const MAX_HEADLINE_LENGTH = 30;
export const MAX_DESCRIPTION_LENGTH = 90;
// Google allows at most 3 enabled responsive search ads in one ad group.
export const MAX_ADS_PER_AD_GROUP = 3;

export const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'] as const;
export const DEFAULT_MODEL = 'claude-haiku-5-5';
export const COPY_MAX_ATTEMPTS = 3; // per article; after that the article is reported as "no ad copy"
export const COPY_MAX_TOKENS = 4000;

export const UPLOAD_MAX_ATTEMPTS = 3; // per campaign
export const DEFAULT_DAILY_CAP = 14000; // Basic access is 15,000 operations a day, shared with every tool on the token
export const SYNC_RESERVE = 40; // operations uploads leave free for the sync

export const WAVES = ['pilot', 'rest'] as const;
export type Wave = (typeof WAVES)[number];

export const MATCH_TYPES = ['PHRASE', 'EXACT', 'BROAD'] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

// The default copy instructions (the Kitchen rules of the rsa repo). Used when a run's box is empty
// and no app default has been saved.
export const KITCHEN_COPY_RULES = [
  'Describe what the reader gets from the article. Do not promise anything the article title doesn\'t support.',
  'No clickbait or sensational wording. Never use: hidden, secret, revealed, reveal, truth about, warning, shocking, you won\'t believe, what happens, the real reason, read the full, unlock, mystery. No questions that hold back the answer to make people click. Say plainly what the article covers.',
  'Where it fits naturally, use "Best" and "2026" in a few headlines (e.g. "Best Banana Bread Recipe", "Banana Bread Recipe 2026"). Not in every headline, and only where it reads naturally.',
].join('\n');

export const TICK_SECONDS = 60;
export const SYNC_EVERY_HOURS = 24;
