import { test } from 'node:test';
import assert from 'node:assert/strict';
import PizZip from 'pizzip';
import { validateDraft, resolveCitations, draftToText, draftToDocx, draftFilename, sampleText } from '../src/drafts.mjs';
import { runTool } from '../src/tools.mjs';
import { runAgent, toConverseMessages } from '../src/agent.mjs';
import { buildSystemPrompt } from '../src/prompt.mjs';

const library = {
  get: (id) => ({ '63-683.24G': { id: '63-683.24G', cite: '63 O.S. § 683.24G', heading: 'Severe weather warnings and alerts', text: 'x' } })[String(id).trim()],
  normalizeId: (id) => id,
  search: () => [],
  omagTitles: []
};

test('validateDraft keeps known block types and trims the rest', () => {
  const d = validateDraft({ title: '  Lightning Plan ', blocks: [
    { type: 'heading', level: 7, text: 'Scope' }, { type: 'paragraph', text: '' }, { type: 'script', text: 'x' },
    { type: 'bullets', items: ['a', '', 3] }, { type: 'signature', items: ['Camp Director'] }
  ] });
  assert.equal(d.title, 'Lightning Plan');
  assert.deepEqual(d.blocks.map((b) => b.type), ['heading', 'bullets', 'signature']);
  assert.equal(d.blocks[0].level, 1);
  assert.deepEqual(d.blocks[1].items, ['a']);
  assert.throws(() => validateDraft({ title: 'x', blocks: [] }), /no content/);
  assert.throws(() => validateDraft({ blocks: [{ type: 'paragraph', text: 'x' }] }), /title/);
  assert.throws(() => validateDraft({ title: 'x', blocks: Array.from({ length: 40 }, () => ({ type: 'paragraph', text: 'y'.repeat(5000) })) }), /too long/);
});

test('citations become formal cites only for sections Ranger read', () => {
  const d = validateDraft({ title: 'T', blocks: [{ type: 'paragraph', text: 'Keep two ways to get alerts. [[63-683.24G]] It must do X. [[99-1-1]]' }] });
  const r = resolveCitations(d, library, new Set(['63-683.24G']));
  assert.equal(r.draft.blocks[0].text, 'Keep two ways to get alerts. (63 O.S. § 683.24G) It must do X.');
  assert.deepEqual(r.dropped, ['99-1-1']);
  const unread = resolveCitations(d, library, new Set());
  assert.ok(!/683\.24G/.test(unread.draft.blocks[0].text), 'a section Ranger did not read is dropped');
});

test('write_document tool hands the draft to the turn', () => {
  const drafts = [];
  const r = runTool('write_document', { title: 'Water Safety Plan', subtitle: 'Camp Hope, Town of Hope', blocks: [{ type: 'paragraph', text: 'Hi' }] }, library, { drafts, seen: new Set() });
  assert.equal(r.result.shown, true);
  assert.match(r.result.message, /tailored to their camp/);
  assert.equal(drafts[0].subtitle, 'Camp Hope, Town of Hope');
  const bad = runTool('write_document', { title: 'x' }, library, { drafts });
  assert.match(bad.result.error, /no content/);
  assert.equal(drafts.length, 1);
});

test('get_sample is not offered yet, but the code is ready for OMAG samples', async () => {
  // No templates or loadSample → only research tools and write_document.
  let tools;
  await runAgent({ history: [{ role: 'user', text: 'hi' }], library, turn: async (a) => { tools = a.tools; return { stopReason: 'end_turn', usage: {}, content: [{ text: 'ok' }] }; } });
  assert.deepEqual(tools.map((t) => t.toolSpec.name), ['search_law', 'get_sections', 'write_document']);

  const deps = {
    getTemplate: async () => ({ title: 'Lightning Plan', enabled: true, variants: { all: { key: 'k' } }, fields: [{ key: 'camp_name', label: 'Camp name' }] }),
    pickVariant: () => ({ variant: 'all' }),
    getBlob: async () => Buffer.from('x'),
    extractText: async () => 'The {{camp_name}} stops activities.{{#has_pool}} Clear the pool.{{/has_pool}}'
  };
  const s = await sampleText('lightning', 'camp', deps);
  assert.equal(s.text, 'The [Camp name] stops activities. Clear the pool.');
  const r = await runTool('get_sample', { template_id: 'lightning' }, library, { templates: [{ id: 'lightning' }], loadSample: (id) => sampleText(id, 'camp', deps) });
  assert.equal(r.result.title, 'Lightning Plan');
  assert.match(r.result.how_to_use, /fresh/);
  const missing = await runTool('get_sample', { template_id: 'nope' }, library, { templates: [], loadSample: () => {} });
  assert.match(missing.result.error, /No sample/);
});

test('the prompt interviews for camp details before writing', () => {
  const p = buildSystemPrompt({ form: 'camp', city: 'City of Ada' });
  assert.match(p, /# Writing documents/);
  for (const topic of [/day camp or overnight/, /staff-to-camper ratios/, /pool, lake or river/, /who makes emergency calls/, /health, allergies and medications/, /HB 1675/, /two to four/, /\[brackets\]/, /Never invent facts, names, phone numbers, addresses, dates, amounts/]) assert.match(p, topic);
  assert.doesNotMatch(p, /offer_document|get_sample/, 'no fill-in tool and no samples yet');
});

test('the current draft goes back to the model with the member’s message', () => {
  const draft = { title: 'Check-In and Check-Out Procedure', blocks: [{ type: 'paragraph', text: 'Parents sign campers in.' }] };
  const msgs = toConverseMessages([{ role: 'user', text: 'Make it shorter', draft }]);
  assert.match(msgs[0].content[0].text, /<current_draft>[\s\S]*# Check-In and Check-Out Procedure[\s\S]*Parents sign campers in/);
  assert.equal(msgs[0].content[1].text, 'Make it shorter');
  assert.equal(toConverseMessages([{ role: 'user', text: 'hi', draft: { title: '' } }])[0].content.length, 1, 'a bad draft is ignored');
});

test('a document written in the last round is kept', async () => {
  let n = 0;
  const turn = async ({ onToolStart, maxTokens }) => {
    n++;
    assert.equal(maxTokens, 16000);
    if (n === 1) return { stopReason: 'tool_use', usage: {}, content: [{ toolUse: { toolUseId: 'a', name: 'search_law', input: { query: 'x' } } }] };
    onToolStart?.('write_document');
    return { stopReason: 'tool_use', usage: {}, content: [{ toolUse: { toolUseId: 'b', name: 'write_document', input: { title: 'Emergency Action Plan', blocks: [{ type: 'paragraph', text: 'Body' }] } } }] };
  };
  let t = 0;
  const events = [];
  const r = await runAgent({ history: [{ role: 'user', text: 'write our plan' }], library, turn, emit: (e) => events.push(e), timeBudgetMs: 5, now: () => (t += 10) });
  assert.equal(r.draft.title, 'Emergency Action Plan');
  assert.match(r.text, /draft I wrote for your camp/);
  assert.deepEqual(r.toolCalls.map((c) => c.name), ['search_law', 'write_document']);
  assert.deepEqual(r.toolCalls[1].input, { title: 'Emergency Action Plan' }, 'logs keep the title only');
  assert.ok(events.some((e) => e.type === 'status' && e.text === 'Writing your document. Longer documents take a few minutes'));
});

test('Word file has headings, lists, signature lines and the draft footer', async () => {
  const d = validateDraft({ title: 'Swim Supervision Plan', subtitle: 'Camp Hope, Town of Hope, Oklahoma', blocks: [
    { type: 'heading', level: 1, text: 'Ratios' }, { type: 'paragraph', text: 'Approved by the **Parks and Recreation Director**.' },
    { type: 'numbered', items: ['Swim test', 'Buddy check'] }, { type: 'numbered', items: ['Again'] }, { type: 'signature', items: ['Camp Director', 'Aquatics Supervisor'] }
  ] });
  const buf = await draftToDocx(d, { today: new Date('2026-11-17T18:00:00Z') });
  const zip = new PizZip(buf);
  const xml = zip.file('word/document.xml').asText();
  for (const s of ['Swim Supervision Plan', 'Camp Hope, Town of Hope, Oklahoma', 'Ratios', 'Parks and Recreation Director', 'Aquatics Supervisor', 'Date: ____']) assert.ok(xml.includes(s), s);
  assert.match(xml, /<w:b\/>/);
  assert.match(xml, /w:w="12240" w:h="15840"/, 'US Letter');
  const footer = Object.keys(zip.files).filter((f) => /footer/.test(f)).map((f) => zip.file(f).asText()).join('');
  assert.match(footer, /DRAFT prepared with Ranger, OMAG’s AI assistant, on November 17, 2026\. Review with your municipal attorney or OMAG before use\./);
  assert.match(draftToText(d), /1\. Swim test[\s\S]*1\. Again/);
  assert.equal(draftFilename(d, 'Town of Hope'), 'Swim Supervision Plan - Town of Hope.docx');
  assert.equal(draftFilename({ title: 'Town of Hope Swim Plan' }, 'Town of Hope'), 'Town of Hope Swim Plan.docx');
});
