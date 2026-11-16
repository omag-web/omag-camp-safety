// Long-running work started from the admin panel (or on a schedule) that runs in the Ranger
// worker function, not the API: rebuilding the statute library and running answer checks.
// Each task has one status record the admin panel polls.

import { kv } from './storage.mjs';

export const TASKS = {
  'build-library': 'Statute library rebuild',
  'run-checks': 'Answer check'
};
const STALE_MS = 16 * 60_000;   // the worker stops at 15 minutes; a run silent this long has died

export async function getJob(task) {
  const j = await kv.get('CONFIG', `job#${task}`);
  if (!j) return { task, state: 'idle' };
  const { pk, sk, ...rest } = j;
  if (['queued', 'running'].includes(rest.state) && Date.now() - Date.parse(rest.updatedAt) > STALE_MS) {
    return { ...rest, state: 'failed', message: 'It stopped reporting before it finished (it may have run out of time). Try again.' };
  }
  return rest;
}

export async function setJob(task, fields) {
  const cur = (await kv.get('CONFIG', `job#${task}`)) || { pk: 'CONFIG', sk: `job#${task}`, task };
  await kv.put({ ...cur, ...fields, updatedAt: new Date().toISOString() });
}

const local = new Map();   // running locally (no worker function): task → promise, for tests and npm run dev

/** Starts a task in the worker. Refuses if the same task is already running. */
export async function startJob(task, by) {
  if (!TASKS[task]) throw Object.assign(new Error('Unknown task.'), { status: 400 });
  const cur = await getJob(task);
  if (['queued', 'running'].includes(cur.state)) throw Object.assign(new Error(`${TASKS[task]} is already running. Give it a few minutes.`), { status: 409 });
  const now = new Date().toISOString();
  await setJob(task, { state: 'queued', by, queuedAt: now, startedAt: null, finishedAt: null, message: 'Starting…', log: [], progress: null });
  if (process.env.WORKER_FUNCTION) {
    const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
    await new LambdaClient({}).send(new InvokeCommand({
      FunctionName: process.env.WORKER_FUNCTION,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ task, by }))
    }));
  } else {
    const { runTask } = await import('./worker.mjs');
    local.set(task, runTask(task, by).catch((e) => console.error(task, 'failed', e)));
  }
  return getJob(task);
}

/** Waits for a locally started task (tests). */
export const _waitLocal = (task) => local.get(task);
