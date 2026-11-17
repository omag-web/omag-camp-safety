import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import PizZip from 'pizzip';
import { installShim, makeResponseStream } from '../scripts/lambda-shim.mjs';

installShim();
const { handler } = await import('../src/handler.mjs');
const { blobs } = await import('../src/storage.mjs');
const { numberWords, memberTemplates } = await import('../src/templates.mjs');

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const docText = (b64) => {
  const zip = new PizZip(Buffer.from(b64, 'base64'));
  return zip.file('word/document.xml').asText().replace(/<w:p[ >][^]*?<\/w:p>/g, (p) => p.replace(/<[^>]+>/g, '') + '\n').replace(/<[^>]+>/g, '');
};

async function rawCall(method, path, { body } = {}) {
  const stream = makeResponseStream();
  const [rawPath, qs] = path.split('?');
  await handler({ rawPath, queryStringParameters: qs ? Object.fromEntries(new URLSearchParams(qs)) : undefined, headers: {}, body: body ? JSON.stringify(body) : undefined, requestContext: { http: { method, sourceIp: '203.0.113.7' } } }, stream);
  await stream.done;
  const r = stream.result();
  let json; try { json = JSON.parse(r.body); } catch {}
  return { ...r, json };
}
// Members no longer fill in templates: Ranger writes documents itself (drafts.mjs). The template
// machinery stays for OMAG samples later (get_sample), so these tests still check it: the old
// member routes go to memberTemplates() and the admin panel's "Test with sample answers" route.
async function call(method, path, opts = {}) {
  if (method === 'GET' && path.startsWith('/templates?')) {
    const form = new URLSearchParams(path.split('?')[1]).get('form');
    return { statusCode: 200, json: { templates: await memberTemplates(form) } };
  }
  if (method === 'POST' && path === '/templates/fill') {
    const b = opts.body || {};
    if (!/^[a-z0-9-]{3,64}$/.test(String(b.templateId || ''))) return { statusCode: 400, json: {} };
    const enabled = (await memberTemplates(b.form || 'unsure')).some((t) => t.id === b.templateId);
    if (!enabled) return { statusCode: 404, json: { error: 'not offered' } };
    return rawCall('POST', `/admin/templates/${b.templateId}/test`, { body: { form: b.form, values: b.values } });
  }
  return rawCall(method, path, opts);
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

const chatEvents = async (body) => {
  const s = makeResponseStream();
  await handler({ rawPath: '/chat', headers: {}, body: JSON.stringify(body), requestContext: { http: { method: 'POST', sourceIp: '203.0.113.8' } } }, s);
  await s.done;
  return s.result().body.trim().split('\n').map((l) => JSON.parse(l));
};

test('Ranger writes a custom document in chat, and can revise it', async () => {
  process.env.MODEL_MODE = 'mock';
  const events = await chatEvents({ conversationId: 'conv_doc_1', form: 'camp', city: 'City of Ada', messages: [{ role: 'user', text: 'Can you write a lightning plan for Camp Wintersmith in the City of Ada?' }] });
  assert.ok(events.some((e) => e.type === 'status' && /Writing your document. Longer documents take a few minutes/.test(e.text)), 'tells the member it is writing');
  const done = events.find((e) => e.type === 'done');
  assert.ok(done?.draft, JSON.stringify(events));
  assert.equal(done.draft.title, 'Severe Weather and Lightning Plan');
  assert.equal(done.draft.subtitle, 'Camp Wintersmith, City of Ada, Oklahoma');
  assert.ok(!done.documents, 'no fill-in template offer');

  // The member asks for a change; the draft they see goes back to Ranger with the question.
  const again = await chatEvents({ conversationId: 'conv_doc_1', form: 'camp', messages: [
    { role: 'user', text: 'Can you write a lightning plan for Camp Wintersmith in the City of Ada?' },
    { role: 'assistant', text: 'Here it is.' },
    { role: 'user', text: 'Please update it to add the pool.', draft: done.draft }
  ] });
  const d2 = again.find((e) => e.type === 'done');
  assert.match(d2.draft.blocks[1].text, /Revised/);

  // Download as Word: a real .docx with the text and the draft footer.
  const r = await call('POST', '/documents/docx', { body: { draft: d2.draft, municipality: 'City of Ada', form: 'camp', browserId: 'b_123456' } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.json));
  assert.equal(r.json.filename, 'Severe Weather and Lightning Plan - City of Ada.docx');
  const zip = new PizZip(Buffer.from(r.json.data, 'base64'));
  const xml = zip.file('word/document.xml').asText();
  assert.match(xml, /Purpose/);
  assert.match(xml, /Revised/);
  assert.match(xml, /w:w="12240"/, 'US Letter paper');
  assert.match(xml, /w:top="1440"/, '1-inch margins');
  const footer = Object.keys(zip.files).filter((f) => /footer/.test(f)).map((f) => zip.file(f).asText()).join('');
  assert.match(footer, /DRAFT prepared with Ranger, OMAG’s AI assistant/);
  assert.match(footer, /Review with your municipal attorney or OMAG before use/);

  const bad = await call('POST', '/documents/docx', { body: { draft: { title: '', blocks: [] } } });
  assert.equal(bad.statusCode, 400);
  assert.equal((await rawCall('POST', '/templates/fill', { body: { templateId: 'hazard-assessment' } })).statusCode, 404, 'the fill-in route is gone');
});

test('analytics count documents downloaded', async () => {
  const a = (await call('GET', '/admin/analytics', { body: undefined })).json;
  assert.ok(a.totals.documents >= 1, JSON.stringify(a.totals));
  assert.ok(a.documents.some((d) => d.name === 'Severe Weather and Lightning Plan'), JSON.stringify(a.documents));
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
