// Everything an admin can now change without GitHub or AWS: the statute library's sources and
// rebuilds, answer checks, who gets Ranger's emails, and how long conversations are kept.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installShim, makeResponseStream } from '../scripts/lambda-shim.mjs';

installShim();
process.env.MODEL_MODE = 'mock';
process.env.CHECK_RETRY_MS = '0';
const dir = mkdtempSync(join(tmpdir(), 'ranger-manage-'));
process.env.LOCAL_DATA_DIR = dir;
delete process.env.TABLE_NAME; delete process.env.DATA_BUCKET; delete process.env.USER_POOL_ID; delete process.env.WORKER_FUNCTION; delete process.env.CONTACT_TOPIC_ARN;

// A stand-in for pdftotext: the "PDF" we serve is already text.
const fake = join(dir, 'pdftotext');
writeFileSync(fake, '#!/bin/sh\ncat "$3"\n');
chmodSync(fake, 0o755);
process.env.PDFTOTEXT = fake;

const { handler } = await import('../src/handler.mjs');
const { _waitLocal } = await import('../src/jobs.mjs');
const { _localSet } = await import('../src/notify.mjs');
const { grade, validateQuestions } = await import('../src/checks.mjs');

async function call(method, path, { body } = {}) {
  const stream = makeResponseStream();
  await handler({ rawPath: path, headers: {}, body: body ? JSON.stringify(body) : undefined, requestContext: { http: { method, sourceIp: '203.0.113.9' } } }, stream);
  await stream.done;
  const r = stream.result();
  let json; try { json = JSON.parse(r.body); } catch {}
  return { ...r, json };
}

/** A Title 11 "PDF" (as text) with enough sections to pass the library's size check. */
function title11({ withNepotism = true } = {}) {
  const lines = [];
  for (let i = 1; i <= 560; i++) {
    lines.push(`§11-1-${100 + i}. Test heading number ${i}.`, `Section body ${i} about municipal employees and zebra${i}.`, `Laws 1977, c. 256, § 1-${100 + i}.`);
  }
  if (withNepotism) lines.push('§11-8-106.', '', 'Nepotism - Dual office holding.', '', 'No officer shall appoint a relative quokkaword.', 'Laws 1977, c. 256, § 8-106.');
  return lines.join('\n');
}

const sourcesBody = (over = {}) => ({
  oklahoma: [{ title: '11', name: 'Cities and Towns', url: 'https://oklegislature.gov/OK_Statutes/CompleteTitles/os11.pdf', include: '^11-1- ^11-8-', why: 'Test' }],
  federal: [],
  required: '11-8-106',
  ...over
});

test('statute sources: edited and validated in the admin panel', async () => {
  let r = await call('GET', '/admin/library/sources');
  assert.equal(r.statusCode, 200);
  assert.ok(r.json.config.oklahoma.some((s) => s.title === '63'));

  r = await call('PUT', '/admin/library/sources', { body: sourcesBody() });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json.config.oklahoma[0].include, ['^11-1-', '^11-8-']);
  assert.deepEqual(r.json.config.required, ['11-8-106']);
  assert.equal(r.json.updatedBy, 'local-dev');
  assert.match(r.json.config.bills?.[0]?.name || '', /HB 1675/, 'saving from the admin page keeps the enrolled-bill fallback');

  for (const [bad, why] of [
    [{ oklahoma: [{ title: '11', url: 'http://example.com/a.pdf', include: '^11-' }] }, /https/],
    [{ oklahoma: [{ title: '11', url: 'https://example.com/a.pdf', include: '^11-(' }] }, /valid pattern/],
    [{ oklahoma: [{ title: '11', url: 'https://x.org/a.pdf', include: '^11-' }, { title: '11', url: 'https://x.org/b.pdf', include: '^11-' }] }, /twice/],
    [{ federal: [{ title: 99, part: '825' }], oklahoma: [] }, /1 to 50/],
    [{ required: 'not an id!' }, /section id/]
  ]) {
    const res = await call('PUT', '/admin/library/sources', { body: sourcesBody(bad) });
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.match(res.json.error, why);
  }
});

test('library rebuild runs from the admin panel and Ranger uses the result', async () => {
  const realFetch = globalThis.fetch;
  try {
    await call('PUT', '/admin/library/sources', { body: sourcesBody() });
    globalThis.fetch = async () => new Response(title11());
    let r = await call('POST', '/admin/library/rebuild');
    assert.equal(r.statusCode, 200, r.body);
    assert.ok(['queued', 'running'].includes(r.json.job.state));
    assert.equal((await call('POST', '/admin/library/rebuild')).statusCode, 409, 'one rebuild at a time');
    await _waitLocal('build-library');
    r = await call('GET', '/admin/library/build');
    assert.equal(r.json.job.state, 'done', JSON.stringify(r.json.job));
    assert.match(r.json.job.message, /Built 561 sections/);
    const src = await call('POST', '/admin/library/search', { body: { query: 'quokkaword' } });
    assert.equal(src.json.results[0].id, '11-8-106');

    // A required section that disappears stops the build; Ranger keeps the library it has.
    globalThis.fetch = async () => new Response(title11({ withNepotism: false }));
    await call('POST', '/admin/library/rebuild');
    await _waitLocal('build-library');
    r = await call('GET', '/admin/library/build');
    assert.equal(r.json.job.state, 'failed');
    assert.match(r.json.job.message, /11-8-106/);
    assert.ok(r.json.job.log.length);
    assert.equal((await call('POST', '/admin/library/search', { body: { query: 'quokkaword' } })).json.results[0].id, '11-8-106', 'the last good library stays');
  } finally { globalThis.fetch = realFetch; }
});

test('answer checks: questions are validated, run, graded and kept', async () => {
  assert.throws(() => validateQuestions([{ q: '', form: 'town', expect: ['11-12-106'] }]), /empty/);
  assert.throws(() => validateQuestions([{ q: 'Hi', form: 'town' }]), /good answer/);
  assert.deepEqual(validateQuestions([{ q: 'Hi', form: 'nope', expect: ['11-1-101 or 11-1-102', '25-307'] }])[0], { q: 'Hi', form: 'unsure', expect: [['11-1-101', '11-1-102'], '25-307'] });
  assert.deepEqual(grade({ expect: [['a', 'b'], 'c'], mustNot: ['6789'] }, { text: 'ssn 6789', cited: ['b'] }), ['Didn’t cite c', 'Must not say /6789/']);

  let r = await call('GET', '/admin/checks');
  assert.ok(r.json.questions.length >= 30, 'starts from the repo’s questions');
  r = await call('PUT', '/admin/checks/questions', { body: { questions: [
    { q: 'Can the mayor suspend an employee?', form: 'town', expect: [] , mustInclude: ['.'] },
    { q: 'Our clerk, SSN 123-45-6789, wants leave.', form: 'cm', expect: [], mustNot: ['123-45-6789'] }
  ] } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await call('PUT', '/admin/checks/questions', { body: { questions: [{ q: 'x', expect: ['bad id!'] }] } })).statusCode, 400);

  r = await call('POST', '/admin/checks/run');
  assert.equal(r.statusCode, 200, r.body);
  await _waitLocal('run-checks');
  r = await call('GET', '/admin/checks');
  assert.equal(r.json.job.state, 'done', JSON.stringify(r.json.job));
  assert.equal(r.json.runs.length, 1);
  assert.equal(r.json.runs[0].total, 2);
  assert.equal(r.json.runs[0].results, undefined, 'the list stays small');
  const run = (await call('GET', `/admin/checks/runs/${r.json.runs[0].id}`)).json.run;
  assert.equal(run.results.length, 2);
  assert.ok(run.results.every((x) => !x.answer.includes('123-45-6789')), 'ID numbers are removed before the model sees them');
});

test('email recipients: two lists; notes go to the alerts list until someone confirms on the messages list', async () => {
  const { notify } = await import('../src/notify.mjs');
  let r = await call('GET', '/admin/recipients');
  assert.deepEqual(r.json.lists, { messages: [], alerts: [] });
  _localSet('alerts', 'matt@example.org', { pending: false, id: '11111111-2222-3333-4444-555555555555' });
  r = await call('POST', '/admin/recipients/messages', { body: { email: 'HR@Example.org' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json.lists.messages.some((x) => x.email === 'hr@example.org' && x.pending));
  assert.equal(r.json.lists.alerts.length, 1, 'lists are separate');
  assert.equal((await call('POST', '/admin/recipients/messages', { body: { email: 'hr@example.org' } })).statusCode, 400, 'no duplicates');
  assert.equal((await call('POST', '/admin/recipients/messages', { body: { email: 'not-an-email' } })).statusCode, 400);
  assert.equal((await call('POST', '/admin/recipients/nope', { body: { email: 'a@b.org' } })).statusCode, 400);

  assert.equal(await notify('test', 'body', 'messages'), 'alerts', 'nobody confirmed on messages yet');
  _localSet('messages', 'hr@example.org', { pending: false, id: '22222222-2222-3333-4444-555555555555' });
  assert.equal(await notify('test', 'body', 'messages'), 'messages');

  r = await call('DELETE', '/admin/recipients/alerts/11111111-2222-3333-4444-555555555555');
  assert.equal(r.statusCode, 400);
  assert.match(r.json.error, /at least one confirmed/);
  r = await call('DELETE', '/admin/recipients/messages/22222222-2222-3333-4444-555555555555');
  assert.equal(r.statusCode, 200, 'the messages list can be emptied');
  assert.deepEqual(r.json.lists.messages, []);
});

test('retention: set in Settings, shown to members, used for new records', async () => {
  assert.equal((await call('PUT', '/admin/settings', { body: { retentionDays: 10 } })).statusCode, 400);
  const r = await call('PUT', '/admin/settings', { body: { retentionDays: 365 } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json.settings.retentionDays, 365);
  assert.equal((await call('GET', '/config')).json.retentionDays, 365);
});

test('document starters ask which document to write; old template ids are dropped', async () => {
  const r = await call('PUT', '/admin/settings', { body: { starters: [
    { kicker: 'Create a document', text: 'Build a document', doc: true, templateId: '' },
    { kicker: 'Policy', text: 'Build our personnel policies', doc: true, templateId: 'personnel-policy' },
    { kicker: 'Ask', text: 'A question', templateId: 'ignored-for-questions' }
  ] } });
  assert.equal(r.statusCode, 200, r.body);
  const starters = (await call('GET', '/config')).json.starters;
  assert.deepEqual(starters, [
    { kicker: 'Create a document', text: 'Build a document', doc: true },
    { kicker: 'Policy', text: 'Build our personnel policies', doc: true },
    { kicker: 'Ask', text: 'A question' }
  ]);
});

test('answer checks always finish: a question the model never answers is marked, not waited on', async () => {
  const { runChecks } = await import('../src/checks.mjs');
  const turn = async ({ messages, onText }) => {
    if (/slow/.test(messages[0].content[0].text)) return new Promise(() => {});   // never answers
    onText('An answer.');
    return { stopReason: 'end_turn', usage: {}, content: [{ text: 'An answer.' }] };
  };
  const started = Date.now();
  const run = await runChecks({
    questions: [{ q: 'fast one', form: 'town', mustInclude: ['answer'] }, { q: 'slow one', form: 'town', mustInclude: ['answer'] }, { q: 'fast two', form: 'town', mustInclude: ['answer'] }],
    concurrency: 2, deadline: Date.now() + 5000, hardStop: Date.now() + 300, turn
  });
  assert.ok(Date.now() - started < 3000, 'did not wait for the hung question');
  assert.equal(run.total, 2, 'only questions that finished count');
  assert.equal(run.passed, 2);
  assert.equal(run.notRun, 1);
  assert.match(run.results[1].problems[0], /still answering/);
});


test('attachments: read, cleaned, limited, and shown to the model as the member’s document', async () => {
  const { toConverseMessages } = await import('../src/agent.mjs');
  const text = 'PERSONNEL POLICY\n\nSection 4. Leave. Employees get 10 days of sick leave. Contact HR, SSN 123-45-6789 on file.';
  let r = await call('POST', '/attach', { body: { name: 'Handbook 2024.txt', data: Buffer.from(text).toString('base64') } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json.name, 'Handbook 2024.txt');
  assert.match(r.json.text, /sick leave/);
  assert.ok(!r.json.text.includes('123-45-6789'), 'ID numbers removed before Ranger sees the file');
  assert.equal(r.json.truncated, false);

  for (const [name, data, why] of [
    ['old.doc', 'eA==', /\.docx/],
    ['photo.png', 'eA==', /PDF, Word/],
    ['empty.txt', Buffer.from('   ').toString('base64'), /empty|didn’t find any text/],
    ['big.txt', Buffer.alloc(4 * 1024 * 1024 + 10, 97).toString('base64'), /over 4 MB/]
  ]) {
    const res = await call('POST', '/attach', { body: { name, data } });
    assert.ok([400, 413].includes(res.statusCode), `${name}: ${res.statusCode}`);
    if (res.statusCode === 400) assert.match(res.json.error, why);
  }

  const msgs = toConverseMessages([{ role: 'user', text: 'Is this compliant?', attachments: [{ name: 'Handbook 2024.txt', text: 'Section 4. Leave.' }, { name: 'Old.pdf', text: '' }] }]);
  assert.equal(msgs[0].content.length, 3);
  assert.match(msgs[0].content[0].text, /^<member_document name="Handbook 2024.txt">\nSection 4\. Leave\.\n<\/member_document>$/);
  assert.match(msgs[0].content[1].text, /isn't available any more/);
  assert.equal(msgs[0].content[2].text, 'Is this compliant?');

  // A chat with an attachment answers, and the log keeps only the file's name.
  r = await call('POST', '/chat', { body: { conversationId: 'conv_attach_1', browserId: 'b', form: 'town', messages: [{ role: 'user', text: 'Review this policy', attachments: [{ name: 'Handbook 2024.txt', text: 'Section 4. Leave. SSN 123-45-6789' }] }] } });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /"type":"done"/);
  const turn = (await call('GET', '/admin/conversations/conv_attach_1')).json.turns[0];
  assert.deepEqual(turn.attachments, ['Handbook 2024.txt']);
  assert.ok(!JSON.stringify(turn).includes('Section 4'), 'the file’s text isn’t stored');
});
