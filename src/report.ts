import type { RunDb } from './db.ts';

export const REPORT_HEADER = ['Row', 'URL', 'Title', 'Keywords', 'Result', 'Reason', 'Campaign', 'Ad group', 'Theme', 'Ad ID', 'Google review', 'Policy topics', 'Headlines', 'Descriptions'];

// The run's final report: one line per row of the uploaded file, nothing left out.
export async function reportRows(db: RunDb): Promise<(string | number)[][]> {
  const campaigns = new Map((await db.campaigns()).map((c) => [c.name, c]));
  const lines: { row: number; cells: (string | number)[] }[] = [];
  for (const a of await db.allArticles()) {
    const campaign = campaigns.get(a.campaign);
    let result: string;
    let reason = a.error ?? '';
    if (a.ad_status === 'uploaded') result = a.error ? 'Created (with a note)' : 'Created';
    else if (a.ad_status === 'error') result = 'Not created: rejected';
    else if (a.ad_status === 'skipped') result = 'Not created: no ad copy';
    else if (a.copy_status === 'failed') {
      result = 'Not created: no ad copy';
      reason = `no ad copy: ${a.copy_error ?? 'failed'}`;
    } else if (campaign?.status === 'failed') {
      result = 'Not created: campaign failed';
      reason = campaign.error ?? '';
    } else result = 'Not uploaded yet';
    lines.push({
      row: a.row_number,
      cells: [a.row_number, a.url, a.title, a.keywords.join(', '), result, reason, a.campaign, a.ad_group, a.theme ?? '', a.ad_id ?? '', a.approval ?? '', a.policy_topics ?? '', (a.headlines ?? []).join(' | '), (a.descriptions ?? []).join(' | ')],
    });
  }
  for (const s of await db.skippedRows()) {
    lines.push({ row: s.row_number, cells: [s.row_number, s.url, s.title, s.keywords, 'Not created', s.reason.replace(/^not created: /, ''), '', '', '', '', '', '', '', ''] });
  }
  lines.sort((x, y) => x.row - y.row);
  return [REPORT_HEADER, ...lines.map((l) => l.cells)];
}
