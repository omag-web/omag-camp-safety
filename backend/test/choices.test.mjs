import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installShim, makeResponseStream } from '../scripts/lambda-shim.mjs';

installShim();
process.env.MODEL_MODE = 'mock';
process.env.LOCAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'ranger-choices-'));
delete process.env.TABLE_NAME; delete process.env.DATA_BUCKET; delete process.env.USER_POOL_ID;
const { handler } = await import('../src/handler.mjs');
const { validateChoice, choiceText } = await import('../src/choices.mjs');
const { runAgent, toConverseMessages } = await import('../src/agent.mjs');
const { buildSystemPrompt } = await import('../src/prompt.mjs');

const library = { get: () => null, normalizeId: (x) => x, search: () => [], omagTitles: [] };
const chat = async (body) => {
  const s = makeResponseStream();
  await handler({ rawPath: '/chat', headers: {}, body: JSON.stringify(body), requestContext: { http: { method: 'POST', sourceIp: '203.0.113.20' } } }, s);
  await s.done;
  return s.result().body.trim().split('\n').map((l) => JSON.parse(l));
};

test('choice questions are tidied: trimmed, de-duplicated, exclusive only with multiple', () => {
  const c = validateChoice({ question: '  Day or  overnight? ', options: ['Day camp', ' day camp', 'Overnight camp', ''], exclusive: ['Day camp'] });
  assert.deepEqual(c, { question: 'Day or overnight?', options: ['Day camp', 'Overnight camp'], multiple: false, other: true });
  const m = validateChoice({ question: 'Which?', options: ['A', 'B', 'None'], multiple: true, exclusive: ['none', 'Z'], other: false });
  assert.deepEqual(m.exclusive, ['None']);
  assert.equal(m.other, false);
  assert.throws(() => validateChoice({ question: 'Which?', options: ['Only one'] }), /two different options/);
  assert.throws(() => validateChoice({ options: ['A', 'B'] }), /needs a question/);
  assert.match(choiceText(m), /more than one allowed\): A \| B \| None\]/);
});

test('ask_choice ends the turn; text written before it stays, and the question is added once', async () => {
  const events = [];
  let calls = 0;
  const turn = async ({ onText }) => {
    calls++;
    onText('Thanks, that helps.');
    return { stopReason: 'tool_use', usage: {}, content: [{ text: 'Thanks, that helps.' }, { toolUse: { toolUseId: 't1', name: 'ask_choice', input: { question: 'Is there a pool?', options: ['Yes', 'No', 'Not sure'] } } }] };
  };
  const r = await runAgent({ history: [{ role: 'user', text: 'Overnight camp' }], library, turn, emit: (e) => events.push(e) });
  assert.equal(calls, 1, 'no second model call');
  assert.equal(r.text, 'Thanks, that helps.\n\nIs there a pool?');
  assert.deepEqual(r.choice.options, ['Yes', 'No', 'Not sure']);
  assert.ok(!events.some((e) => e.type === 'reset'), 'the lead-in is not cleared');
  assert.deepEqual(r.toolCalls.map((t) => t.name), ['ask_choice']);
});

test('a broken ask_choice goes back to the model as an error instead of ending the turn', async () => {
  let n = 0, result;
  const turn = async ({ messages, onText }) => {
    n++;
    if (n === 1) return { stopReason: 'tool_use', usage: {}, content: [{ toolUse: { toolUseId: 't1', name: 'ask_choice', input: { question: 'Which?', options: ['One'] } } }] };
    result = messages[messages.length - 1].content[0].toolResult.content[0].json;
    onText('Which camp is this for?');
    return { stopReason: 'end_turn', usage: {}, content: [{ text: 'Which camp is this for?' }] };
  };
  const r = await runAgent({ history: [{ role: 'user', text: 'hi' }], library, turn });
  assert.match(result.error, /at least two different options/);
  assert.equal(r.text, 'Which camp is this for?');
  assert.equal(r.choice, undefined);
});

test('the model sees which buttons the member had', () => {
  const msgs = toConverseMessages([
    { role: 'user', text: 'Write a water safety plan' },
    { role: 'assistant', text: 'Is this a day camp or an overnight camp?', choice: { question: 'Is this a day camp or an overnight camp?', options: ['Day camp', 'Overnight camp'] } },
    { role: 'user', text: 'Overnight camp' }
  ]);
  assert.match(msgs[1].content[0].text, /Answer buttons shown to the member: Day camp \| Overnight camp \| or type another answer\]/);
});

test('the prompt asks one question at a time and offers buttons', () => {
  const p = buildSystemPrompt({ form: 'camp' });
  assert.match(p, /# Asking the member questions/);
  assert.match(p, /Ask one question per reply, then stop and wait for the answer/);
  assert.match(p, /ask it with ask_choice/);
  assert.match(p, /even where the guidance says to ask several questions at a time/);
  assert.doesNotMatch(p, /two to four|a few related questions at a time|reply with numbers/);
});

test('through /chat: the done event carries the choice, and the answer continues the conversation', async () => {
  const first = await chat({ conversationId: 'conv_choice_1', form: 'camp', messages: [{ role: 'user', text: 'Help me write a water safety plan for Camp Hope' }] });
  const done = first.find((e) => e.type === 'done');
  assert.deepEqual(done.choice, { question: 'Is this a day camp or an overnight camp?', options: ['Day camp', 'Overnight camp', 'Both', 'Not sure'], multiple: false, other: true });
  const text = first.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.equal(text, 'Is this a day camp or an overnight camp?');
  assert.equal(done.draft, undefined);

  const second = await chat({ conversationId: 'conv_choice_1', form: 'camp', messages: [
    { role: 'user', text: 'Help me write a water safety plan for Camp Hope' },
    { role: 'assistant', text, choice: done.choice },
    { role: 'user', text: 'Overnight camp' }
  ] });
  const d2 = second.find((e) => e.type === 'done');
  assert.ok(d2.draft, 'the mock writes the document once it has the answer');
  assert.equal(d2.choice, undefined);

  const multi = await chat({ conversationId: 'conv_choice_2', form: 'unsure', messages: [{ role: 'user', text: 'Help us find which city facilities and programs might be covered' }] });
  const c = multi.find((e) => e.type === 'done').choice;
  assert.equal(c.multiple, true);
  assert.deepEqual(c.exclusive, ['None', 'Not sure']);
});

test('saved settings with the old welcome text show the new one-question-at-a-time wording', async () => {
  const { kv } = await import('../src/storage.mjs');
  const { getConfig } = await import('../src/config.mjs');
  await kv.put({ pk: 'CONFIG', sk: 'settings', welcomeText: "I'm OMAG's AI assistant for the Oklahoma camp safety law (HB 1675). I can help you find which of your facilities and programs may be covered, and write the plans, policies and forms your camp needs. I'll ask about your camp a few questions at a time, then write each document from scratch for you." });
  assert.match((await getConfig({ fresh: true })).settings.welcomeText, /one question at a time/);
  await kv.put({ pk: 'CONFIG', sk: 'settings', welcomeText: 'OMAG’s own words.' });
  assert.equal((await getConfig({ fresh: true })).settings.welcomeText, 'OMAG’s own words.', 'custom text is left alone');
});
