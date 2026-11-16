import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import PizZip from 'pizzip';
import { installShim, makeResponseStream } from '../scripts/lambda-shim.mjs';

installShim();
const { handler } = await import('../src/handler.mjs');
const { blobs } = await import('../src/storage.mjs');
const { numberWords } = await import('../src/templates.mjs');

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const docText = (b64) => {
  const zip = new PizZip(Buffer.from(b64, 'base64'));
  return zip.file('word/document.xml').asText().replace(/<w:p[ >][^]*?<\/w:p>/g, (p) => p.replace(/<[^>]+>/g, '') + '\n').replace(/<[^>]+>/g, '');
};

async function call(method, path, { body } = {}) {
  const stream = makeResponseStream();
  const [rawPath, qs] = path.split('?');
  await handler({ rawPath, queryStringParameters: qs ? Object.fromEntries(new URLSearchParams(qs)) : undefined, headers: {}, body: body ? JSON.stringify(body) : undefined, requestContext: { http: { method, sourceIp: '203.0.113.7' } } }, stream);
  await stream.done;
  const r = stream.result();
  let json; try { json = JSON.parse(r.body); } catch {}
  return { ...r, json };
}
async function upload(id, variant, file) {
  const buf = fixture(file);
  const u = await call('POST', `/admin/templates/${id}/upload`, { body: { variant, filename: file, size: buf.length } });
  assert.equal(u.statusCode, 200, JSON.stringify(u.json));
  await blobs.put(u.json.key, buf);
  return call('POST', `/admin/templates/${id}/attach`, { body: { variant, key: u.json.key, filename: file } });
}

test('numbers print as words', () => {
  assert.equal(numberWords(3), 'three');
  assert.equal(numberWords(21), 'twenty-one');
  assert.equal(numberWords(480), 'four hundred eighty');
  assert.equal(numberWords(1.5), '1.5');
});

let id;
test('admin: create a template, upload Word files, questions are found automatically', async () => {
  const c = await call('POST', '/admin/templates', { body: { title: 'Test Hazard Assessment', description: 'A test.' } });
  id = c.json.template.id;
  assert.equal(c.json.template.enabled, false);
  assert.equal((await call('PUT', `/admin/templates/${id}`, { body: { enabled: true } })).statusCode, 400, 'no file yet → can’t turn on');

  const a = await upload(id, 'all', 'template-all.docx');
  assert.equal(a.statusCode, 200, JSON.stringify(a.json));
  assert.deepEqual(a.json.tags, ['alert_method', 'has_overnight', 'max_campers', 'municipality_name', 'review_date', 'shelter_location', 'site_name'], 'built-in fields (program_type) aren’t questions');
  const ov = a.json.template.fields.find((f) => f.key === 'has_overnight');
  assert.equal(ov.type, 'yesno', '{{#sections}} become yes/no questions');

  const t = await upload(id, 'campground', 'template-campground.docx');
  assert.deepEqual(t.json.added, ['campsite_count']);

  const broken = await upload(id, 'camp', 'template-broken.docx');
  assert.equal(broken.statusCode, 400);
  assert.match(broken.json.error, /isn’t written correctly/);
  const bad = await upload(id, 'camp', 'template-badname.docx');
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json.error, /lowercase letters/);
  assert.equal((await call('POST', `/admin/templates/${id}/upload`, { body: { variant: 'all', filename: 'old.doc', size: 10 } })).statusCode, 400, '.doc is refused with a hint');
  assert.equal((await call('POST', `/admin/templates/${id}/upload`, { body: { variant: 'town', filename: 'x.docx', size: 10 } })).statusCode, 400, 'only program types are versions');
});

test('admin: edit questions, then members see only the questions their version uses', async () => {
  const cur = (await call('GET', `/admin/templates/${id}`)).json.template;
  const fields = cur.fields.map((f) => ({
    ...f,
    ...(f.key === 'municipality_name' ? { label: 'Official name', required: true, prefill: 'municipality' } : {}),
    ...(f.key === 'alert_method' ? { type: 'select', default: 'radio', options: [{ value: 'radio', label: 'NOAA weather radio', text: 'NOAA weather radio' }, { value: 'siren', label: 'Outdoor siren', text: 'outdoor warning siren' }] } : {}),
    ...(f.key === 'max_campers' ? { type: 'number' } : {}),
    ...(f.key === 'review_date' ? { type: 'date' } : {})
  }));
  const u = await call('PUT', `/admin/templates/${id}`, { body: { fields, notes: ['Walk the site before relying on it.'], enabled: true } });
  assert.equal(u.statusCode, 200, JSON.stringify(u.json));
  assert.equal((await call('PUT', `/admin/templates/${id}`, { body: { fields: [{ key: 'Bad Key' }] } })).statusCode, 400);
  assert.equal((await call('PUT', `/admin/templates/${id}`, { body: { fields: [{ key: 'x', type: 'select', options: [] }] } })).statusCode, 400, 'choices need options');

  const cg = (await call('GET', '/templates?form=campground')).json.templates.find((t) => t.id === id);
  assert.equal(cg.variant, 'campground');
  assert.ok(cg.fields.some((f) => f.key === 'campsite_count'));
  const camp = (await call('GET', '/templates?form=camp')).json.templates.find((t) => t.id === id);
  assert.equal(camp.variant, 'all');
  assert.ok(!camp.fields.some((f) => f.key === 'campsite_count'), 'campground-only question hidden from camps');
  assert.deepEqual(cg.notes, ['Walk the site before relying on it.']);
});

test('members: fill a document; blanks print as lines; sections follow yes/no answers', async () => {
  const r = await call('POST', '/templates/fill', { body: { templateId: id, form: 'camp', municipality: 'City of Ada', browserId: 'b_test', values: { municipality_name: 'City of Ada', site_name: 'Wintersmith Park Day Camp', alert_method: 'siren', max_campers: 3, review_date: '2029-12-08', has_overnight: true, not_a_field: 'ignored' } } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.json));
  assert.equal(r.json.filename, 'Test Hazard Assessment - City of Ada.docx');
  const text = docText(r.json.data);
  assert.match(text, /operated by the City of Ada as a Youth camp or outdoor program\./);
  assert.match(text, /Primary shelter: ________\./, 'unanswered → blank line');
  assert.match(text, /Up to three \(3\) participants/);
  assert.match(text, /Overnight lodging is provided/);
  assert.match(text, /Primary warning method: outdoor warning siren\./);
  assert.match(text, /Next review by December 8, 2029\./);
  assert.ok(!/\{\{|ignored/.test(text));
  assert.deepEqual(r.json.blanks, ['Shelter location']);

  const no = docText((await call('POST', '/templates/fill', { body: { templateId: id, form: 'campground', values: { municipality_name: 'Town of Bly', has_overnight: false } } })).json.data);
  assert.ok(!/Overnight lodging/.test(no), 'section removed when the answer is no');
  assert.match(no, /as a Recreational campground/);
  assert.match(no, /Campsites: ________\./);

  assert.equal((await call('POST', '/templates/fill', { body: { templateId: 'nope-0000' } })).statusCode, 404);
});

test('a program-type-only file is offered to that type only; disabled templates are hidden', async () => {
  const c = await call('POST', '/admin/templates', { body: { title: 'Campground Only' } });
  const cgId = c.json.template.id;
  await upload(cgId, 'campground', 'template-campground.docx');
  await call('PUT', `/admin/templates/${cgId}`, { body: { enabled: true } });
  const cg = (await call('GET', '/templates?form=campground')).json.templates.find((t) => t.id === cgId);
  assert.equal(cg.variant, 'campground');
  assert.equal(cg.fallback, null);
  assert.ok(!(await call('GET', '/templates?form=camp')).json.templates.some((t) => t.id === cgId), 'no file for camps → not listed');
  await call('PUT', `/admin/templates/${cgId}`, { body: { enabled: false } });
  assert.ok(!(await call('GET', '/templates?form=campground')).json.templates.some((t) => t.id === cgId));
  const test = await call('POST', `/admin/templates/${cgId}/test`, { body: { form: 'campground', values: { municipality_name: 'City of Test' } } });
  assert.equal(test.statusCode, 200, 'admins can test a template before turning it on');
  await call('DELETE', `/admin/templates/${cgId}`);
});

test('template packs export and import', async () => {
  const ex = (await call('GET', '/admin/templates-export')).json;
  const zip = new PizZip(Buffer.from(ex.data, 'base64'));
  const manifest = JSON.parse(zip.file('manifest.json').asText());
  assert.ok(manifest.templates.some((t) => t.id === id && Object.keys(t.variants).length === 2));
  await call('DELETE', `/admin/templates/${id}`);
  assert.ok(!(await call('GET', '/templates?form=camp')).json.templates.some((t) => t.id === id));
  const up = (await call('POST', '/admin/templates-import/upload')).json;
  await blobs.put(up.key, Buffer.from(ex.data, 'base64'));
  const im = await call('POST', '/admin/templates-import', { body: { key: up.key } });
  assert.equal(im.statusCode, 200, JSON.stringify(im.json));
  const back = (await call('GET', '/templates?form=camp')).json.templates.find((t) => t.id === id);
  assert.ok(back && back.fields.find((f) => f.key === 'alert_method').options.length === 2, 'questions survive the round trip');
});

test('Ranger offers a document in chat, with answers the member gave', async () => {
  process.env.MODEL_MODE = 'mock';
  const s = makeResponseStream();
  // Use the template id the mock picks for "emergency action plan".
  const c = await call('POST', '/admin/templates', { body: { title: 'Emergency Action Plan' } });
  const eapId = c.json.template.id;
  const { kv } = await import('../src/storage.mjs');
  const t = await kv.get('TEMPLATE', eapId);
  await kv.del('TEMPLATE', eapId);
  await kv.put({ ...t, sk: 'emergency-action-plan', id: 'emergency-action-plan' });
  await upload('emergency-action-plan', 'all', 'template-all.docx');
  await call('PUT', '/admin/templates/emergency-action-plan', { body: { enabled: true } });

  await handler({ rawPath: '/chat', headers: {}, body: JSON.stringify({ conversationId: 'conv_doc_1', form: 'camp', messages: [{ role: 'user', text: 'Can you build our emergency action plan for the City of Ada?' }] }), requestContext: { http: { method: 'POST', sourceIp: '203.0.113.8' } } }, s);
  await s.done;
  const events = s.result().body.trim().split('\n').map((l) => JSON.parse(l));
  const done = events.find((e) => e.type === 'done');
  assert.ok(done, JSON.stringify(events));
  assert.equal(done.documents.length, 1);
  assert.equal(done.documents[0].templateId, 'emergency-action-plan');
  assert.deepEqual(done.documents[0].prefill, { municipality_name: 'City of Ada' });
});

test('analytics count documents built', async () => {
  const a = (await call('GET', '/admin/analytics', { body: undefined })).json;
  assert.ok(a.totals.documents >= 2, JSON.stringify(a.totals));
  assert.ok(a.documents.some((d) => d.name === 'Test Hazard Assessment'));
});

test('the starter template pack imports and every document fills cleanly', async () => {
  const pack = readFileSync(new URL('../../knowledge/templates/ranger-camp-safety-templates.zip', import.meta.url));
  const up = (await call('POST', '/admin/templates-import/upload')).json;
  await blobs.put(up.key, pack);
  const im = await call('POST', '/admin/templates-import', { body: { key: up.key } });
  assert.equal(im.statusCode, 200, JSON.stringify(im.json));

  const camp = (await call('GET', '/templates?form=camp')).json.templates;
  const cg = (await call('GET', '/templates?form=campground')).json.templates;
  for (const want of ['hazard-assessment', 'emergency-action-plan', 'hazard-disclosure', 'training-drill-record']) {
    assert.ok(camp.some((t) => t.id === want), `${want} offered to youth camps`);
  }
  const eapCamp = camp.find((t) => t.id === 'emergency-action-plan');
  const eapCg = cg.find((t) => t.id === 'emergency-action-plan');
  assert.equal(eapCg.variant, 'campground', 'campgrounds get the campground plan');
  assert.ok(eapCamp.fields.some((f) => f.key === 'warning_method_2') && !eapCamp.fields.some((f) => f.key === 'camper_alerts'));
  assert.ok(eapCg.fields.some((f) => f.key === 'camper_alerts') && !eapCg.fields.some((f) => f.key === 'reunification'));

  for (const [form, list] of [['camp', camp], ['campground', cg]]) {
    for (const t of list) {
      const values = Object.fromEntries(t.fields.map((f) => [f.key, f.type === 'yesno' ? true : f.type === 'number' ? 40 : f.type === 'date' ? '2027-01-01' : `Value for ${f.key}\nsecond line`]));
      const r = await call('POST', '/templates/fill', { body: { templateId: t.id, form, values } });
      assert.equal(r.statusCode, 200, `${t.id} (${form}): ${JSON.stringify(r.json)}`);
      const text = docText(r.json.data);
      assert.ok(!/\{\{|\}\}/.test(text), `${t.id} (${form}) has no leftover tags`);
      assert.deepEqual(r.json.blanks, [], `${t.id} (${form}) every question used`);
      assert.match(text, /Value for municipality_name/);
    }
  }
  const ha = docText((await call('POST', '/templates/fill', { body: { templateId: 'hazard-assessment', form: 'facility', values: { municipality_name: 'City of Ada', has_risk_scores: false } } })).json.data);
  assert.match(ha, /as a Camp facility|Program type: Camp facility/);
  assert.ok(!/Supplemental planning priorities/.test(ha), 'optional risk scores hidden when not chosen');
});
