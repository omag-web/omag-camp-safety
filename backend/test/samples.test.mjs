import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PizZip from 'pizzip';
import { installShim, makeResponseStream } from '../scripts/lambda-shim.mjs';

installShim();
process.env.MODEL_MODE = 'mock';
process.env.LOCAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'ranger-samples-'));
delete process.env.TABLE_NAME; delete process.env.DATA_BUCKET; delete process.env.USER_POOL_ID;
const { handler } = await import('../src/handler.mjs');
const { blobs } = await import('../src/storage.mjs');
const { samplesFor, readSample } = await import('../src/samples.mjs');

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

async function call(method, path, { body } = {}) {
  const stream = makeResponseStream();
  await handler({ rawPath: path, headers: {}, body: body ? JSON.stringify(body) : undefined, requestContext: { http: { method, sourceIp: '203.0.113.7' } } }, stream);
  await stream.done;
  const r = stream.result();
  let json; try { json = JSON.parse(r.body); } catch {}
  return { ...r, json };
}
async function upload(id, version, file) {
  const buf = fixture(file);
  const u = await call('POST', `/admin/samples/${id}/upload`, { body: { version, filename: file, size: buf.length } });
  assert.equal(u.statusCode, 200, JSON.stringify(u.json));
  await blobs.put(u.json.key, buf);
  return call('POST', `/admin/samples/${id}/attach`, { body: { version, key: u.json.key, filename: file } });
}
const chatEvents = async (body) => {
  const s = makeResponseStream();
  await handler({ rawPath: '/chat', headers: {}, body: JSON.stringify(body), requestContext: { http: { method: 'POST', sourceIp: '203.0.113.8' } } }, s);
  await s.done;
  return s.result().body.trim().split('\n').map((l) => JSON.parse(l));
};

let id;
test('admin: add a sample and upload a plain Word file (no fields needed)', async () => {
  const c = await call('POST', '/admin/samples', { body: { title: 'Lightning safety plan', description: 'Lightning: monitoring, when to stop, shelter, all-clear' } });
  assert.equal(c.statusCode, 200, JSON.stringify(c.json));
  id = c.json.sample.id;
  assert.equal(c.json.sample.enabled, false);
  assert.equal((await call('PUT', `/admin/samples/${id}`, { body: { enabled: true } })).statusCode, 400, 'no file yet → can’t turn on');

  const a = await upload(id, 'all', 'sample-lightning-plan.docx');
  assert.equal(a.statusCode, 200, JSON.stringify(a.json));
  assert.ok(a.json.chars > 200);
  assert.equal(a.json.truncated, false);

  const tiny = await upload(id, 'camp', 'sample-tiny.docx');
  assert.equal(tiny.statusCode, 400);
  assert.match(tiny.json.error, /almost no text/);
  const bad = await upload(id, 'camp', 'not-a-docx.docx');
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json.error, /couldn’t be read/);
  assert.equal((await call('POST', `/admin/samples/${id}/upload`, { body: { version: 'all', filename: 'old.doc', size: 10 } })).statusCode, 400, '.doc is refused with a hint');
  assert.equal((await call('POST', `/admin/samples/${id}/upload`, { body: { version: 'town', filename: 'x.docx', size: 10 } })).statusCode, 400, 'only program types are versions');

  const cg = await upload(id, 'campground', 'sample-lightning-plan-campground.docx');
  assert.equal(cg.statusCode, 200);
  const list = (await call('GET', '/admin/samples')).json;
  assert.deepEqual(Object.keys(list.samples[0].files).sort(), ['all', 'campground']);
  assert.equal(list.versions.campground, 'Recreational campground');
});

test('only samples that are switched on are offered, with the version for the program type', async () => {
  assert.deepEqual(await samplesFor('camp'), [], 'switched off');
  assert.equal((await call('PUT', `/admin/samples/${id}`, { body: { enabled: true } })).statusCode, 200);
  assert.deepEqual((await samplesFor('camp')).map((s) => s.id), [id]);
  assert.match((await readSample(id, 'camp')).text, /Trigger: When thunder is heard/);
  assert.match((await readSample(id, 'campground')).text, /campground hosts warn campers/, 'campgrounds get their own version');
  assert.match((await samplesFor('camp'))[0].description, /monitoring, when to stop/);
});

test('Ranger is offered get_sample only when samples are on, and reads one before writing', async () => {
  const { runAgent } = await import('../src/agent.mjs');
  const library = { get: () => null, normalizeId: (x) => x, search: () => [], omagTitles: [] };
  let tools, system;
  const turn = async (a) => { tools = a.tools; system = a.system; return { stopReason: 'end_turn', usage: {}, content: [{ text: 'ok' }] }; };
  await runAgent({ history: [{ role: 'user', text: 'hi' }], library, turn, samples: await samplesFor('camp'), loadSample: (sid) => readSample(sid, 'camp') });
  assert.ok(tools.some((t) => t.toolSpec.name === 'get_sample'));
  assert.match(system, new RegExp(`${id}: Lightning safety plan`));
  assert.match(system, /write it fresh, in your own words.*Never copy its wording, names, numbers or details/s);

  const { runTool } = await import('../src/tools.mjs');
  const r = await runTool('get_sample', { sample_id: id }, library, { samples: await samplesFor('camp'), loadSample: (sid) => readSample(sid, 'camp') });
  assert.equal(r.result.title, 'Lightning safety plan');
  assert.match(r.result.text, /All-clear/);
  assert.match(r.result.how_to_use, /fresh/);
  const missing = await runTool('get_sample', { sample_id: 'nope' }, library, { samples: [], loadSample: () => {} });
  assert.match(missing.result.error, /No sample/);

  // Through the real chat route: the mock still writes the document; get_sample was available.
  const events = await chatEvents({ conversationId: 'conv_smp_1', form: 'camp', messages: [{ role: 'user', text: 'Please write a lightning plan for Camp Hope in the Town of Hope.' }] });
  assert.ok(events.find((e) => e.type === 'done')?.draft);
});

test('switching off or deleting a sample stops Ranger using it', async () => {
  await call('PUT', `/admin/samples/${id}`, { body: { enabled: false } });
  assert.deepEqual(await samplesFor('camp'), []);
  await assert.rejects(readSample(id, 'camp'), /isn’t available/);
  const rm = await call('POST', `/admin/samples/${id}/remove-file`, { body: { version: 'campground' } });
  assert.deepEqual(Object.keys(rm.json.sample.files), ['all']);
  const del = await call('DELETE', `/admin/samples/${id}`);
  assert.deepEqual(del.json.samples, []);
  assert.equal((await call('GET', `/admin/samples/${id}`)).statusCode, 404);
});

test('Ranger writes a custom document in chat, revises it, and builds the Word file', async () => {
  const events = await chatEvents({ conversationId: 'conv_doc_1', form: 'camp', city: 'City of Ada', messages: [{ role: 'user', text: 'Can you write a lightning plan for Camp Wintersmith in the City of Ada?' }] });
  assert.ok(events.some((e) => e.type === 'status' && /Writing your document. Longer documents take a few minutes/.test(e.text)), 'tells the member it is writing');
  const done = events.find((e) => e.type === 'done');
  assert.ok(done?.draft, JSON.stringify(events));
  assert.equal(done.draft.title, 'Severe Weather and Lightning Plan');
  assert.equal(done.draft.subtitle, 'Camp Wintersmith, City of Ada, Oklahoma');

  const again = await chatEvents({ conversationId: 'conv_doc_1', form: 'camp', messages: [
    { role: 'user', text: 'Can you write a lightning plan for Camp Wintersmith in the City of Ada?' },
    { role: 'assistant', text: 'Here it is.' },
    { role: 'user', text: 'Please update it to add the pool.', draft: done.draft }
  ] });
  const d2 = again.find((e) => e.type === 'done');
  assert.match(d2.draft.blocks[1].text, /Revised/);

  const r = await call('POST', '/documents/docx', { body: { draft: d2.draft, municipality: 'City of Ada', form: 'camp', browserId: 'b_123456' } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.json));
  assert.equal(r.json.filename, 'Severe Weather and Lightning Plan - City of Ada.docx');
  const zip = new PizZip(Buffer.from(r.json.data, 'base64'));
  const xml = zip.file('word/document.xml').asText();
  assert.match(xml, /Revised/);
  assert.match(xml, /w:w="12240"/, 'US Letter paper');
  assert.match(xml, /w:top="1440"/, '1-inch margins');
  const footer = Object.keys(zip.files).filter((f) => /footer/.test(f)).map((f) => zip.file(f).asText()).join('');
  assert.match(footer, /DRAFT prepared with Ranger, OMAG’s AI assistant/);

  assert.equal((await call('POST', '/documents/docx', { body: { draft: { title: '', blocks: [] } } })).statusCode, 400);
  for (const gone of ['/templates/fill', '/admin/templates']) assert.equal((await call('POST', gone, { body: {} })).statusCode, 404, `${gone} is gone`);
});

test('analytics count documents downloaded', async () => {
  const a = (await call('GET', '/admin/analytics')).json;
  assert.ok(a.totals.documents >= 1, JSON.stringify(a.totals));
  assert.ok(a.documents.some((d) => d.name === 'Severe Weather and Lightning Plan'), JSON.stringify(a.documents));
});
