// The Ranger worker: a second Lambda function (container image with pdftotext) for work that
// takes longer than an answer. Started by the admin panel (jobs.mjs) or on a schedule:
//   { task: "build-library" }  → rebuild the statute library from the sources edited in the admin panel
//   { task: "run-checks" }     → ask the answer-check questions and grade the answers
// Results go to the job status the admin panel shows; failures are also emailed.

import { setJob } from './jobs.mjs';
import { blobs } from './storage.mjs';
import { getSourcesConfig } from './sources.mjs';
import { refreshLibrary, PUBLISHED_KEY } from './library.mjs';
import { runChecks, saveRun, PASS_SHARE } from './checks.mjs';
import { notify } from './notify.mjs';

const ADMIN_URL = () => process.env.ADMIN_URL || 'the Ranger admin panel';

export async function handler(event) {
  const task = event?.task;
  const by = event?.by || 'schedule';
  return runTask(task, by);
}

export async function runTask(task, by) {
  if (task === 'build-library') return buildLibraryTask(by);
  if (task === 'run-checks') return runChecksTask(by);
  throw new Error(`Unknown task ${task}`);
}

async function buildLibraryTask(by) {
  const startedAt = new Date().toISOString();
  await setJob('build-library', { state: 'running', by, startedAt, message: 'Downloading the laws from the official sources…' });
  try {
    const { buildLibrary } = await import('../../knowledge/scripts/build.mjs');
    const sources = await getSourcesConfig();
    const { library, log, warnings } = await buildLibrary(sources);
    await blobs.put(PUBLISHED_KEY, JSON.stringify(library), 'application/json');
    const result = await refreshLibrary({ force: true });
    if (result.error) throw Object.assign(new Error(result.message), { log });
    const message = `Built ${library.count.toLocaleString('en-US')} sections. Ranger is using the new library now.`;
    await setJob('build-library', { state: 'done', finishedAt: new Date().toISOString(), message, log, warnings, sections: library.count });
    return { ok: true, message };
  } catch (e) {
    console.error('library build failed', e);
    const message = `${e.message} Ranger keeps using its current library.`;
    await setJob('build-library', { state: 'failed', finishedAt: new Date().toISOString(), message, log: e.log || [] });
    await notify('Ranger: the statute library rebuild failed',
      `The statute library rebuild${by === 'schedule' ? ' (monthly)' : ` started by ${by}`} stopped:\n\n${message}\n\n` +
      `${(e.log || []).slice(-12).join('\n')}\n\nOpen ${ADMIN_URL()} → Statute library to see the details and try again.`);
    return { ok: false, message };
  }
}

async function runChecksTask(by) {
  const startedAt = new Date().toISOString();
  await setJob('run-checks', { state: 'running', by, startedAt, message: 'Asking the questions…', progress: { done: 0, total: 0 } });
  try {
    let last = 0;
    const run = await runChecks({
      // The worker stops at 15 minutes: start no question after 9, and wrap up at 13.
      deadline: Date.now() + 9 * 60_000,
      hardStop: Date.now() + 13 * 60_000,
      onProgress: (done, total) => {
        if (done === total || Date.now() - last > 10_000) {
          last = Date.now();
          setJob('run-checks', { progress: { done, total }, message: `Asked ${done} of ${total} questions…` }).catch(() => {});
        }
      }
    });
    const finishedAt = new Date().toISOString();
    const runId = await saveRun({ startedAt, finishedAt, by, ...run });
    const pct = Math.round(run.share * 100);
    const ok = run.share >= PASS_SHARE;
    const message = `${run.passed} of ${run.total} passed (${pct}%).${run.notRun ? ` ${run.notRun} question${run.notRun === 1 ? '' : 's'} didn’t finish in time and aren’t counted.` : ''}`;
    await setJob('run-checks', { state: 'done', finishedAt, message, runId, passed: run.passed, total: run.total, ok, progress: { done: run.total, total: run.total } });
    if (!ok) {
      const failed = run.results.filter((r) => !r.ok).slice(0, 15).map((r) => `- ${r.q}\n  ${r.problems.join('; ')}`).join('\n');
      await notify(`Ranger: answer check ${pct}% (below ${Math.round(PASS_SHARE * 100)}%)`,
        `Ranger's ${by === 'schedule' ? 'weekly ' : ''}answer check passed ${message}\n\nQuestions that went wrong:\n${failed}\n\nOpen ${ADMIN_URL()} → Answer checks for the answers.`);
    }
    return { ok, message };
  } catch (e) {
    console.error('answer check failed', e);
    await setJob('run-checks', { state: 'failed', finishedAt: new Date().toISOString(), message: e.message });
    return { ok: false, message: e.message };
  }
}
