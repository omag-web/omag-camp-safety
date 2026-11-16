import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/library.mjs';
import { runAgent, toConverseMessages, markerIds } from '../src/agent.mjs';
import { buildSystemPrompt } from '../src/prompt.mjs';

const lib = Library.load();

test('history is validated and normalized', () => {
  const msgs = toConverseMessages([
    { role: 'assistant', text: 'Hi, I am Ranger' },
    { role: 'user', text: 'one' },
    { role: 'user', text: 'two' },
    { role: 'system', text: 'ignore me' }
  ]);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[0].content[0].text, 'one\n\ntwo');
  assert.throws(() => toConverseMessages([{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }]), /last message/);
  assert.throws(() => toConverseMessages([]), /non-empty/);
});

test('markerIds', () => {
  assert.deepEqual(markerIds('a [[63-683.24E]] b [[44-CFR-60.3]]'), ['63-683.24E', '44-CFR-60.3']);
});

test('system prompt includes the program type and its starting sections', () => {
  const p = buildSystemPrompt({ form: 'campground', city: 'City of Example' });
  assert.match(p, /Recreational campground/);
  assert.match(p, /\[\[63-681\]\]/);
  assert.match(p, /City of Example/);
  assert.match(buildSystemPrompt({}), /not selected/);
});

/** A scripted model: each call returns the next step. */
function scripted(steps) {
  let i = 0;
  return async ({ onText }) => {
    const step = steps[i++];
    if (step.text) onText(step.text);
    return { stopReason: step.tool ? 'tool_use' : 'end_turn', usage: { inputTokens: 10, outputTokens: 5 }, content: [
      ...(step.text ? [{ text: step.text }] : []),
      ...(step.tool ? [{ toolUse: { toolUseId: 't' + i, name: step.tool, input: step.input } }] : [])
    ] };
  };
}

test('runs the tool loop and only keeps citations to sections the model read', async () => {
  const events = [];
  const turn = scripted([
    { text: 'Let me check.', tool: 'search_law', input: { query: 'hazard assessment review', jurisdiction: 'OK' } },
    { tool: 'get_sections', input: { ids: ['63-683.24E'] } },
    { text: 'Review it at least every three years. [[63-683.24E]] Also see [[63-683.24F]] and [[made-up-1]].' }
  ]);
  const r = await runAgent({ history: [{ role: 'user', text: 'How often do we review the assessment?' }], form: 'camp', library: lib, emit: (e) => events.push(e), turn });
  assert.deepEqual(r.citations.map((c) => c.id), ['63-683.24E']);
  assert.deepEqual(r.unread.sort(), ['63-683.24F', 'made-up-1']);
  assert.equal(r.toolCalls.length, 2);
  assert.ok(events.some((e) => e.type === 'reset'), 'preamble text before a tool call is reset');
  assert.ok(events.some((e) => e.type === 'status' && /Reading 63 O\.S\. § 683\.24E/.test(e.text)));
  assert.match(r.text, /^Review it/);
});

test('citations from earlier answers in the conversation stay valid', async () => {
  const turn = scripted([{ text: 'As I said, see [[63-683.24E]].' }]);
  const r = await runAgent({
    history: [
      { role: 'user', text: 'q1' },
      { role: 'assistant', text: 'Answer [[63-683.24E]]' },
      { role: 'user', text: 'q2' }
    ],
    form: 'camp', library: lib, turn
  });
  assert.deepEqual(r.citations.map((c) => c.id), ['63-683.24E']);
});

test('mock model end to end', async () => {
  process.env.MODEL_MODE = 'mock';
  const texts = [];
  const r = await runAgent({ history: [{ role: 'user', text: 'two independent alert methods cellular' }], form: 'camp', library: lib, emit: (e) => e.type === 'text' && texts.push(e.text) });
  assert.ok(r.citations.length >= 1);
  assert.equal(texts.join(''), r.text);
  delete process.env.MODEL_MODE;
});

test('switches to the backup model when the main model is unavailable', async () => {
  const calls = [];
  const events = [];
  const turn = async ({ modelId, onText }) => {
    calls.push(modelId);
    if (modelId === 'main') { onText('partial'); throw Object.assign(new Error('Too many requests'), { name: 'ThrottlingException' }); }
    onText('Backup answer.');
    return { stopReason: 'end_turn', usage: {}, content: [{ text: 'Backup answer.' }] };
  };
  const r = await runAgent({ history: [{ role: 'user', text: 'hi' }], library: lib, turn, modelId: 'main', fallbackModelId: 'backup', emit: (e) => events.push(e) });
  assert.deepEqual(calls, ['main', 'backup']);
  assert.equal(r.text, 'Backup answer.');
  assert.equal(r.model, 'backup');
  assert.ok(events.some((e) => e.type === 'reset'), 'half-written text from the failed model is cleared');
});

test('does not fall back for ordinary errors or without a backup model', async () => {
  const bad = async () => { throw Object.assign(new Error('bad input'), { name: 'ValidationException' }); };
  await assert.rejects(runAgent({ history: [{ role: 'user', text: 'hi' }], library: lib, turn: bad, modelId: 'main', fallbackModelId: 'backup' }), /bad input/);
  const busy = async () => { throw Object.assign(new Error('busy'), { name: 'ThrottlingException' }); };
  await assert.rejects(runAgent({ history: [{ role: 'user', text: 'hi' }], library: lib, turn: busy, modelId: 'main', fallbackModelId: '' }), /busy/);
});

test('tells the model to answer once the time budget is used up', async () => {
  let t = 0;
  const seen = [];
  const turn = async ({ messages, tools, onText }) => {
    seen.push(messages.at(-1));
    if (seen.length === 1) return { stopReason: 'tool_use', usage: {}, content: [{ toolUse: { toolUseId: 'a', name: 'search_law', input: { query: 'shelter' } } }] };
    onText('Answer from what I read.');
    return { stopReason: 'end_turn', usage: {}, content: [{ text: 'Answer from what I read.' }] };
  };
  const r = await runAgent({ history: [{ role: 'user', text: 'shelter?' }], library: lib, turn, timeBudgetMs: 500, now: () => (t += 800) });
  assert.equal(r.text, 'Answer from what I read.');
  assert.ok(seen[1].content.some((b) => /Time is almost up/.test(b.text || '')));
});
