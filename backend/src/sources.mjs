// The statute library's source list (which Oklahoma titles and federal parts Ranger reads),
// edited on the admin panel's Statute library page. Kept in the data bucket; the copy in
// knowledge/sources.json is only the starting point.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { blobs, kv } from './storage.mjs';

export const SOURCES_KEY = 'published/sources.json';
const LEGACY_URL = 'https://omag-web.github.io/omag-camp-safety/knowledge/sources.json';
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

function bundled() {
  try { return JSON.parse(readFileSync(fileURLToPath(new URL('../../knowledge/sources.json', import.meta.url)), 'utf8')); } catch { return null; }
}

/** The current source list: the admin-edited copy, else the repo's starting copy. */
export async function getSourcesConfig() {
  const buf = await blobs.get(SOURCES_KEY).catch(() => null);
  if (buf) return JSON.parse(buf.toString('utf8'));
  const local = bundled();
  if (local) return local;
  // Older setups published it on GitHub Pages.
  const r = await fetch(LEGACY_URL, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (r?.ok) return r.json();
  throw Object.assign(new Error('The source list isn’t available yet. Save it once on this page.'), { status: 503 });
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);

/** Checks and tidies a source list from the admin panel. Throws a readable 400 on problems. */
export function validateSources(input) {
  if (!input || typeof input !== 'object') throw bad('The source list is missing.');
  const ok = Array.isArray(input.oklahoma) ? input.oklahoma : [];
  const billsIn = Array.isArray(input.bills) ? input.bills : [];
  const fed = Array.isArray(input.federal) ? input.federal : [];
  if (!ok.length && !fed.length) throw bad('Add at least one source.');
  if (ok.length > 40 || fed.length > 40) throw bad('Up to 40 Oklahoma titles and 40 federal parts.');

  const titles = new Set();
  const oklahoma = ok.map((s, i) => {
    const where = `Oklahoma row ${i + 1}`;
    const title = str(s.title, 6).toUpperCase();
    if (!/^\d{1,3}[A-Z]?$/.test(title)) throw bad(`${where}: the title should be a number like 11 or 85A.`);
    if (titles.has(title)) throw bad(`Title ${title} is listed twice.`);
    titles.add(title);
    const url = str(s.url, 500);
    let u;
    try { u = new URL(url); } catch { throw bad(`Title ${title}: the PDF address isn’t a web address.`); }
    if (u.protocol !== 'https:') throw bad(`Title ${title}: the PDF address must start with https://`);
    const include = (Array.isArray(s.include) ? s.include : String(s.include || '').split(/[\s,]+/))
      .map((p) => str(p, 200)).filter(Boolean);
    if (!include.length) throw bad(`Title ${title}: add at least one "Sections to keep" pattern, such as ^${title}-`);
    if (include.length > 40) throw bad(`Title ${title}: up to 40 patterns.`);
    for (const p of include) {
      try { new RegExp(p); } catch { throw bad(`Title ${title}: "${p}" isn’t a valid pattern.`); }
    }
    return { title, name: str(s.name, 80) || `Title ${title}`, url, include, ...(str(s._why ?? s.why, 300) ? { _why: str(s._why ?? s.why, 300) } : {}) };
  });

  const parts = new Set();
  const federal = fed.map((s, i) => {
    const where = `Federal row ${i + 1}`;
    const title = Number(s.title);
    if (!Number.isInteger(title) || title < 1 || title > 50) throw bad(`${where}: the CFR title should be a number from 1 to 50 (for example 29).`);
    const part = str(s.part, 8);
    if (!/^\d{1,4}[A-Z]?$/.test(part)) throw bad(`${where}: the part should be a number like 825.`);
    if (parts.has(`${title}/${part}`)) throw bad(`${title} CFR Part ${part} is listed twice.`);
    parts.add(`${title}/${part}`);
    return { title, part, name: str(s.name, 80) || `${title} CFR ${part}`, ...(str(s._why ?? s.why, 300) ? { _why: str(s._why ?? s.why, 300) } : {}) };
  });

  const required = [...new Set((Array.isArray(input.required) ? input.required : String(input.required || '').split(/[\s,]+/))
    .map((x) => str(x, 40)).filter(Boolean))];
  if (required.length > 300) throw bad('Up to 300 required sections.');
  for (const id of required) if (!/^[0-9A-Za-z][0-9A-Za-z.\-]{2,39}$/.test(id)) throw bad(`"${id}" doesn’t look like a section id (for example 63-683.24E or 51-155).`);

  if (billsIn.length > 20) throw bad('Up to 20 bills.');
  const bills = billsIn.map((b, i) => {
    const where = `Bill ${i + 1}`;
    const title = str(b.title, 6).toUpperCase();
    if (!/^\d{1,3}[A-Z]?$/.test(title)) throw bad(`${where}: the title should be a number like 63.`);
    const url = str(b.url, 500);
    let u;
    try { u = new URL(url); } catch { throw bad(`${where}: the PDF address isn’t a web address.`); }
    if (u.protocol !== 'https:') throw bad(`${where}: the PDF address must start with https://`);
    const headings = Object.fromEntries(Object.entries(b.headings && typeof b.headings === 'object' ? b.headings : {}).slice(0, 60).map(([k, v]) => [str(k, 20), str(v, 120)]).filter(([k, v]) => k && v));
    return { name: str(b.name, 80) || `Bill ${i + 1}`, title, url, headings, ...(str(b._why, 300) ? { _why: str(b._why, 300) } : {}) };
  });
  const mention = Object.fromEntries(Object.entries(input.mention && typeof input.mention === 'object' ? input.mention : {}).slice(0, 50).map(([k, v]) => [str(k, 40), str(v, 60)]).filter(([k, v]) => k && v));

  return { oklahoma, federal, required, ...(bills.length ? { bills } : {}), ...(Object.keys(mention).length ? { mention } : {}) };
}

/** Saves the source list. The next rebuild uses it. */
export async function saveSourcesConfig(input, by) {
  const prev = await getSourcesConfig().catch(() => ({}));
  // The admin page edits titles, federal parts and required sections. Keep the enrolled-bill
  // fallbacks and wording checks unless the request sends its own.
  const clean = validateSources({ bills: prev.bills, mention: prev.mention, ...input });
  const doc = {
    _comment: 'Which laws Ranger can search. Edited on the admin panel (Statute library). "include" patterns are matched against section ids like 63-683.24E.',
    ...clean,
    _required: prev._required || 'Sections every build must contain. The build stops if one is missing, and Ranger keeps using the last good library.',
    updatedAt: new Date().toISOString(),
    updatedBy: by
  };
  await blobs.put(SOURCES_KEY, JSON.stringify(doc, null, 2), 'application/json');
  await kv.put({ pk: 'CONFIG', sk: 'sources-meta', updatedAt: doc.updatedAt, updatedBy: by });
  return doc;
}
