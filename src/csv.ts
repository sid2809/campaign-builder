import type { SkippedRow } from './db.ts';

// Reads CSV text (RFC 4180: quoted fields, doubled quotes, commas and line breaks inside quotes).
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export interface ImportResult {
  problems: string[]; // the file can't be used at all
  articles: { rowNumber: number; url: string; title: string; keywords: string[] }[];
  skipped: SkippedRow[]; // rows that can't become an ad; they go in the final report
}

// The file must have the columns URL, Title and Keyword (several keywords in one cell, separated by commas).
// No row is dropped silently: a row that can't become an ad is listed with its reason.
export function readInput(text: string): ImportResult {
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const urlCol = col('url');
  const titleCol = col('title');
  const keywordCol = col('keyword', 'keywords');
  const problems: string[] = [];
  if (rows.length === 0) problems.push('the file is empty');
  else {
    if (urlCol < 0) problems.push('no "URL" column in the first row');
    if (titleCol < 0) problems.push('no "Title" column in the first row');
    if (keywordCol < 0) problems.push('no "Keyword" column in the first row');
  }
  if (problems.length > 0) return { problems, articles: [], skipped: [] };

  const articles: ImportResult['articles'] = [];
  const skipped: SkippedRow[] = [];
  const firstRowOf = new Map<string, number>();
  rows.slice(1).forEach((cells, i) => {
    const rowNumber = i + 2; // as a spreadsheet shows it: the header is row 1
    if (cells.every((c) => c.trim() === '')) return; // an empty line is not a row
    const url = (cells[urlCol] ?? '').trim();
    const title = (cells[titleCol] ?? '').replace(/\s+/g, ' ').trim();
    const rawKeywords = (cells[keywordCol] ?? '').trim();
    const keywords = [...new Set(rawKeywords.split(',').map((k) => k.replace(/\s+/g, ' ').trim()).filter(Boolean))];
    const skip = (reason: string) => skipped.push({ row_number: rowNumber, url, title, keywords: rawKeywords, reason });
    if (!url) return skip('not created: missing URL');
    if (!isWebUrl(url)) return skip('not created: the URL is not a web address (http or https)');
    if (!title) return skip('not created: missing title');
    if (keywords.length === 0) return skip('not created: missing keyword');
    const first = firstRowOf.get(url);
    if (first !== undefined) return skip(`not created: same URL as row ${first} (one ad per URL)`);
    firstRowOf.set(url, rowNumber);
    articles.push({ rowNumber, url, title, keywords });
  });
  if (articles.length === 0) problems.push('no row has a URL, a title and a keyword');
  return { problems, articles, skipped };
}

function isWebUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
