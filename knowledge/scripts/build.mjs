// Builds Ranger's statute library from official sources. Used by:
//   - the Ranger worker in AWS (backend/src/worker.mjs), started from the admin panel or monthly
//   - knowledge/scripts/build-library.mjs, for building on a developer's computer
//
// Needs network access to oklegislature.gov and ecfr.gov, and `pdftotext` (poppler-utils).

import { writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOklahomaText, parseEcfrXml, parseEnrolledBill, included } from './parse.mjs';

const run = promisify(execFile);
const UA = { 'User-Agent': 'OMAG-Ranger-library-builder/1.1 (+https://www.omag.org/)' };

async function fetchBuf(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(120_000) });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i >= tries) throw new Error(`Couldn’t download ${url} (${e.message})`);
      await new Promise((ok) => setTimeout(ok, 2000 * i));
    }
  }
}

/**
 * Builds the library described by a sources config (the shape of knowledge/sources.json).
 * Returns { library, log, warnings }. Throws if a source fails or a required section is missing;
 * the error's `log` holds what happened, including the raw PDF text around each missing section.
 */
export async function buildLibrary(cfg, { pdftotext = process.env.PDFTOTEXT || 'pdftotext' } = {}) {
  const log = [];
  const warnings = [];
  const say = (line) => { log.push(line); console.log(line); };
  const fail = (msg) => { say(`Stopped: ${msg}`); throw Object.assign(new Error(msg), { log }); };
  const rawText = {};
  const sections = [];

  for (const src of cfg.oklahoma || []) {
    const pdf = join(tmpdir(), `os${src.title}-${process.pid}.pdf`);
    let text;
    try {
      await writeFile(pdf, await fetchBuf(src.url));
      ({ stdout: text } = await run(pdftotext, ['-enc', 'UTF-8', pdf, '-'], { maxBuffer: 1 << 28 }));
    } catch (e) {
      fail(`Title ${src.title} (${src.url}): ${e.message}`);
    } finally {
      await rm(pdf, { force: true });
    }
    rawText[src.title] = text;
    const all = parseOklahomaText(text, src);
    const kept = all.filter((s) => included(s.id, src.include));
    say(`Title ${src.title} O.S.: ${all.length} sections read, ${kept.length} kept`);
    if (!kept.length) fail(`Title ${src.title}: no sections matched "Sections to keep". Check the patterns, or whether the PDF changed.`);
    sections.push(...kept);
  }

  let dates = {};
  if ((cfg.federal || []).length) {
    try {
      const j = JSON.parse((await fetchBuf('https://www.ecfr.gov/api/versioner/v1/titles.json')).toString('utf8'));
      dates = Object.fromEntries(j.titles.map((t) => [String(t.number), t.up_to_date_as_of]));
    } catch (e) { fail(`eCFR: ${e.message}`); }
  }
  for (const src of cfg.federal || []) {
    const date = dates[String(src.title)];
    if (!date) fail(`eCFR has no Title ${src.title}.`);
    let xml;
    try {
      xml = (await fetchBuf(`https://www.ecfr.gov/api/versioner/v1/full/${date}/title-${src.title}.xml?part=${encodeURIComponent(src.part)}`)).toString('utf8');
    } catch (e) { fail(`${src.title} CFR Part ${src.part}: ${e.message}`); }
    const secs = parseEcfrXml(xml, src);
    say(`${src.title} CFR Part ${src.part}: ${secs.length} sections`);
    if (!secs.length) fail(`${src.title} CFR Part ${src.part}: no sections found.`);
    sections.push(...secs);
  }

  // De-duplicate ids (keep first).
  const seen = new Set();
  const unique = sections.filter((s) => (seen.has(s.id) ? false : seen.add(s.id)));

  // Enrolled bills fill in new-law sections the title PDFs don't have yet. The title's text
  // always wins, so once the Legislature republishes the title these stop being used.
  for (const bill of cfg.bills || []) {
    const pdf = join(tmpdir(), `bill-${process.pid}.pdf`);
    let text;
    try {
      await writeFile(pdf, await fetchBuf(bill.url));
      ({ stdout: text } = await run(pdftotext, ['-enc', 'UTF-8', pdf, '-'], { maxBuffer: 1 << 26 }));
    } catch (e) {
      warnings.push(`${bill.name}: ${e.message}`); say(`Warning: ${bill.name}: ${e.message}`);
      continue;
    } finally {
      await rm(pdf, { force: true });
    }
    const secs = parseEnrolledBill(text, bill);
    const added = secs.filter((s) => !seen.has(s.id));
    for (const s of added) { seen.add(s.id); unique.push(s); }
    say(`${bill.name}: ${secs.length} new-law sections read, ${added.length} used (${secs.length - added.length} already in the title PDF)`);
    if (added.length) { const w = `Using the enrolled bill text for ${added.map((s) => s.id).join(', ')} until the Title ${bill.title} PDF includes them.`; warnings.push(w); say(`Note: ${w}`); }
  }

  // Sections Ranger relies on. If any is missing, the parser or a source changed: stop rather than
  // publish a library that silently lacks them (Ranger keeps using the last good one).
  const missing = (cfg.required || []).filter((id) => !seen.has(id));
  if (missing.length) {
    for (const id of missing) {
      const [title, ...rest] = id.split('-');
      const raw = rawText[title] || '';
      const at = raw.search(new RegExp(`§\\s*${title}-${rest.join('-').replace(/[.]/g, '\\.')}\\.`));
      say(`${id}: ${at < 0 ? (raw ? 'its heading isn’t in the PDF text' : 'its title isn’t one of the sources') : 'raw text around its heading:'}`);
      if (at >= 0) say(JSON.stringify(raw.slice(Math.max(0, at - 200), at + 200)));
    }
    fail(`Required sections missing: ${missing.join(', ')}.`);
  }

  for (const [id, word] of Object.entries(cfg.mention || {})) {
    const sec = unique.find((s) => s.id === id);
    if (sec && !new RegExp(word, 'i').test(sec.text)) {
      const w = `${id} doesn't mention "${word}". The source PDF may not include a recent amendment yet.`;
      warnings.push(w); say(`Warning: ${w}`);
    }
  }

  // Sections that ended up inside another section usually mean a heading wasn't recognized.
  const glued = unique.filter((s) => s.jurisdiction === 'OK' && /\n\s*§\s*\d+[A-Z]?-[0-9A-Za-z.\-]*[0-9A-Za-z]\.(\s+[A-Z]|\s*\n)/.test(s.text)).map((s) => s.id);
  if (glued.length) {
    const w = `${glued.length} sections contain another section's heading: ${glued.slice(0, 20).join(', ')}`;
    warnings.push(w); say(`Warning: ${w}`);
  }

  const library = {
    builtAt: new Date().toISOString(),
    sources: {
      oklahoma: 'Oklahoma Statutes (unannotated), Oklahoma Legislature complete titles' + ((cfg.bills || []).length ? '; new-law sections from enrolled bills until the titles include them' : ''),
      federal: Object.fromEntries((cfg.federal || []).map((f) => [`${f.title} CFR ${f.part}`, `eCFR, current as of ${dates[String(f.title)]}`]))
    },
    count: unique.length,
    sections: unique
  };
  say(`Built ${unique.length.toLocaleString('en-US')} sections (${(JSON.stringify(library).length / 1e6).toFixed(1)} MB).`);
  return { library, log, warnings };
}
