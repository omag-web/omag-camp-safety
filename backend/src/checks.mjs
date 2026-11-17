// Answer checks: a list of test questions, each with the laws a good answer should cite
// (and words it must or must not contain). Edited and run from the admin panel's
// "Answer checks" page; the Ranger worker also runs them every Monday.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { blobs, kv } from './storage.mjs';
import { runAgent } from './agent.mjs';
import { getConfig } from './config.mjs';
import { getLibrary } from './library.mjs';
import { samplesFor, readSample } from './samples.mjs';
import { redact } from './privacy.mjs';

export const QUESTIONS_KEY = 'published/check-questions.json';
export const FORMS = ['camp', 'facility', 'campground', 'unsure'];
export const PASS_SHARE = 0.8;
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

function bundled() {
  try { return JSON.parse(readFileSync(fileURLToPath(new URL('../eval/questions.json', import.meta.url)), 'utf8')); } catch { return []; }
}

export async function getQuestions() {
  const buf = await blobs.get(QUESTIONS_KEY).catch(() => null);
  if (buf) return JSON.parse(buf.toString('utf8')).questions || [];
  return bundled();
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map((x) => (Array.isArray(x) ? x : str(x, 300))).filter((x) => (Array.isArray(x) ? x.length : x));

/** Checks and tidies the question list from the admin panel. */
export function validateQuestions(input) {
  if (!Array.isArray(input)) throw bad('Questions must be a list.');
  if (input.length > 100) throw bad('Up to 100 questions.');
  return input.map((c, i) => {
    const n = i + 1;
    const q = str(c.q, 1000);
    if (!q) throw bad(`Question ${n} is empty.`);
    const form = FORMS.includes(c.form) ? c.form : 'unsure';
    // "expect": each entry is a section id, or a list of ids where any one will do.
    const expect = (Array.isArray(c.expect) ? c.expect : []).map((e) => {
      const ids = (Array.isArray(e) ? e : String(e).split(/\s+or\s+|\|/i)).map((x) => str(x, 40)).filter(Boolean);
      for (const id of ids) if (!/^[0-9A-Za-z][0-9A-Za-z.\-]{2,39}$/.test(id)) throw bad(`Question ${n}: "${id}" doesn’t look like a section id.`);
      return ids.length > 1 ? ids : ids[0];
    }).filter(Boolean);
    const out = { q, form, expect };
    for (const k of ['mustInclude', 'mustNot']) {
      const pats = list(c[k]).slice(0, 10);
      for (const p of pats) { try { new RegExp(p, 'i'); } catch { throw bad(`Question ${n}: "${p}" isn’t a valid pattern.`); } }
      if (pats.length) out[k] = pats;
    }
    if (c.any) out.any = true;
    if (!expect.length && !out.mustInclude && !out.mustNot) throw bad(`Question ${n}: say what a good answer cites or mentions.`);
    return out;
  });
}

export async function saveQuestions(input, by) {
  const questions = validateQuestions(input);
  await blobs.put(QUESTIONS_KEY, JSON.stringify({ questions, updatedAt: new Date().toISOString(), updatedBy: by }, null, 2), 'application/json');
  return questions;
}

/** What's wrong with one answer, if anything. */
export function grade(c, { text = '', cited = [] }) {
  const problems = [];
  const hit = (e) => (Array.isArray(e) ? e.some((x) => cited.includes(x)) : cited.includes(e));
  const expect = c.expect || [];
  const citedOk = !expect.length || (c.any ? expect.some(hit) : expect.every(hit));
  if (!citedOk) problems.push(`Didn’t cite ${expect.filter((e) => !hit(e)).map((e) => [].concat(e).join(' or ')).join(', ')}`);
  for (const p of c.mustInclude || []) if (!new RegExp(p, 'i').test(text)) problems.push(`Should mention /${p}/`);
  for (const p of c.mustNot || []) if (new RegExp(p, 'i').test(text)) problems.push(`Must not say /${p}/`);
  return problems;
}

/**
 * Asks every question (several at a time) the way a member would, and grades the answers.
 * No new question starts after `deadline`, and at `hardStop` any question still being answered
 * is marked "not finished", so the run always ends, and is saved, before the worker's 15-minute limit.
 */
export async function runChecks({ questions, concurrency = 10, deadline = Date.now() + 9 * 60_000, hardStop = Date.now() + 13 * 60_000, turn, onProgress = () => {} } = {}) {
  questions ||= await getQuestions();
  const cfg = await getConfig({ fresh: true });
  const library = await getLibrary();
  const results = new Array(questions.length);
  let next = 0;
  let done = 0;

  const ask = async (c) => {
    const r = await runAgent({
      history: [{ role: 'user', text: redact(c.q).text }],
      form: c.form, library, guidance: cfg.guidance,
      modelId: cfg.settings.modelId, fallbackModelId: cfg.settings.fallbackModelId,
      samples: await samplesFor(c.form).catch(() => []), loadSample: (id) => readSample(id, c.form),
      ...(turn ? { turn } : {})
    });
    return { text: r.text, cited: (r.citations || []).map((x) => x.id), model: r.model };
  };

  const OUT_OF_TIME = Symbol('out of time');
  let stopTimer;
  const stopped = new Promise((ok) => { stopTimer = setTimeout(() => ok(OUT_OF_TIME), Math.max(0, hardStop - Date.now())); });
  const askInTime = (c) => Promise.race([ask(c), stopped]);
  const notFinished = (c, i, why) => ({ i, q: c.q, form: c.form, ok: false, skipped: true, problems: [why] });

  const worker = async () => {
    while (next < questions.length) {
      const i = next++;
      const c = questions[i];
      if (Date.now() > deadline) { results[i] = notFinished(c, i, 'Not run: out of time'); continue; }
      const started = Date.now();
      let r;
      try { r = await askInTime(c); } catch (e) {
        // One retry, if there's time for it.
        if (hardStop - Date.now() > 3 * 60_000) {
          await new Promise((ok) => setTimeout(ok, Number(process.env.CHECK_RETRY_MS ?? 15000)));
          try { r = await askInTime(c); } catch (e2) { r = { error: e2.message || e2.name }; }
        } else r = { error: e.message || e.name };
      }
      if (r === OUT_OF_TIME) { results[i] = notFinished(c, i, 'Not finished: the model was still answering when time ran out'); onProgress(++done, questions.length); continue; }
      const problems = r.error ? [`Error: ${r.error}`] : grade(c, r);
      results[i] = { i, q: c.q, form: c.form, ok: !problems.length, cited: r.cited || [], problems, secs: Math.round((Date.now() - started) / 100) / 10, answer: String(r.text || '').slice(0, 3000), ...(r.model ? { model: r.model } : {}) };
      onProgress(++done, questions.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, questions.length) }, worker));
  clearTimeout(stopTimer);

  // Questions that weren't asked (out of time) don't count against Ranger; the run says how many.
  const asked = results.filter((r) => !r.skipped);
  const passed = asked.filter((r) => r.ok).length;
  return { total: asked.length, passed, share: asked.length ? passed / asked.length : 0, notRun: questions.length - asked.length, model: cfg.settings.modelId, results };
}

/** Stores a finished run. Returns its id (the start time, URL-safe). */
export async function saveRun(run) {
  const id = run.startedAt.replace(/[:.]/g, '-');
  await kv.put({ pk: 'CHECKS', sk: `run#${id}`, ...run });
  return id;
}

export async function listRuns(limit = 20) {
  const items = await kv.query('CHECKS', { prefix: 'run#', limit });
  return items.map(({ results, pk, sk, ...summary }) => ({ id: sk.slice(4), ...summary }));
}

export async function getRun(id) {
  const r = await kv.get('CHECKS', `run#${id}`);
  if (!r) throw Object.assign(new Error('That run wasn’t found.'), { status: 404 });
  const { pk, sk, ...rest } = r;
  return { id, ...rest };
}
