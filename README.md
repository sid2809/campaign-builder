# Campaign Builder

A dashboard that turns a list of article URLs into **paused** Google Ads search campaigns
(responsive search ads), for any domain and any ad account under the MCC.

The upload engine comes from [sid2809/rsa](https://github.com/sid2809/rsa) (Faith and Kitchen). That repo and its
services are separate and are not changed by this one.

## What a run does

1. **New run**: pick a domain, upload a CSV (`URL`, `Title`, `Keyword`; several keywords in one cell, separated by
   commas), set the run's options, answer "review before publishing?".
2. **Themes**: the model proposes themes. With review on, you confirm or edit them.
3. **Grouping**: each article is tagged with a theme and topic; code builds ad groups and campaigns
   (one theme per campaign).
4. **Ad copy**: 15 headlines and 4 descriptions per article (Message Batches API).
5. **Approve** (review on only): structure and copy, read-only.
6. **Preflight**: account and currency (INR), labels, countries and languages looked up in Google Ads, campaign
   names not already in the account, a validate-only check of one real campaign, a test campaign created,
   read back and removed.
7. **Upload**: campaigns are created paused. Optional pilot first (spread across themes). Buttons: Enable pilot,
   Upload rest, Enable. Google's review results are fetched once a day (can be turned off per run) and on "Refresh now".
8. **Report**: one line per row of the file, with the result and the reason. Nothing is left out silently.

## Countries and languages

The worker fetches Google's lists of countries and languages once (2 API operations) and stores them, so the forms
offer them by full name. Until they are loaded the forms take codes (`US`, `en`). Either way the preflight asks
Google for each one again before anything is created.

## Fixed rules

- Google Search only; Maximize Clicks with a max CPC cap; presence targeting; text asset automation off.
- Tracking suffix: the same as the rsa repo (`src/config.ts`).
- Budgets and CPC caps are in rupees; the preflight stops a run on an account that is not in INR.
- At most 3 ads per ad group (Google's limit for enabled responsive search ads).
- Google's daily limit is 15,000 operations per developer token, shared with every other tool on it.
  The app counts only its own operations against the daily cap set on the Runs page.

## Run it on Railway

Two services from this repo and one Postgres database, in the same project. Both services use the start command
`npm start`; the `ROLE` variable says which program a service runs.

**Dashboard service** (needs a public domain: Settings > Networking > Generate Domain; health check path `/health`)

| Variable | Value |
| --- | --- |
| `ROLE` | `web` |
| `DATABASE_URL` | Reference to the Postgres service's `DATABASE_URL` |
| `APP_PASSWORD` | The dashboard password (at least 12 characters) |
| `SESSION_SECRET` | Optional. If unset, sign-ins end when the password changes |

**Worker service** (no public domain)

| Variable | Value |
| --- | --- |
| `ROLE` | `worker` |
| `DATABASE_URL` | Reference to the Postgres service's `DATABASE_URL` |
| `ANTHROPIC_API_KEY` | Same key as the rsa services |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Same as the rsa services |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | The MCC ID |
| `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN` | Same as the rsa services |

Run exactly one worker (one replica): two workers would both act on the same runs.

## Develop

```
npm install
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/postgres npm test   # needs a local Postgres
npm run typecheck
```

The tests use an in-memory Google Ads account and a fake batch client (`test/fakes.ts`); every operation is checked
against the Google Ads API message definitions. They never call Google or Anthropic.
