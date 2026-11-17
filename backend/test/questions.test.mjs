import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installShim, makeResponseStream } from '../scripts/lambda-shim.mjs';

installShim();
process.env.MODEL_MODE = 'mock';
process.env.LOCAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'ranger-questions-'));
delete process.env.TABLE_NAME; delete process.env.DATA_BUCKET; delete process.env.USER_POOL_ID;
const { validateQuestion, questionText } = await import('../src/questions.mjs');
const { runAgent, toConverseMessages } = await import('../src/agent.mjs');
const { buildSystemPrompt } = await import('../src/prompt.mjs');
const { handler } = await import('../src/handler.mjs');

const library = { get: () => null, normalizeId: (x) => x, search: () => [], omagTitles: [] };
const chatEvents = async (body) => {
  const s = makeResponseStream();
  await handler({ rawPath: '/chat', headers: {}, body: JSON.stringify(body), requestContext: { http: { method: 'POST', sourceIp: '203.0.113.9' } } }, s);
  await s.done;
  return s.result().body.trim().split('\n').map((l) => JSON.parse(l));
};

test('questions are checked and tidied', () => {
  assert.deepEqual(validateQuestion({ question: ' Day camp or overnight? ', kind: 'choice', options: ['Day camp', 'Overnight', 'Day camp', 'Other', ''] }),
    { question: 'Day camp or overnight?', kind: 'choice', options: ['Day camp', 'Overnight'], allowOther: true });
  assert.deepEqual(validateQuestion({ question: 'How many campers?', kind: 'text', placeholder: 'e.g. 60', options: ['x'] }),
    { question: 'How many campers?', kind: 'text', placeholder: 'e.g. 60' });
  assert.equal(validateQuestion({ question: 'Which?', kind: 'multi', options: ['A', 'B'], allow_other: false }).allowOther, false);
  assert.equal(validateQuestion({ question: 'Name of the camp?', kind: 'choice' }).kind, 'text', 'no options → a typed answer');
  assert.throws(() => validateQuestion({ question: 'Pick', kind: 'choice', options: ['Only one'] }), /at least two/);
  assert.throws(() => validateQuestion({ question: '', kind: 'text' }), /Write the question/);
  assert.equal(validateQuestion({ question: 'Q', kind: 'choice', options: Array.from({ length: 12 }, (_, i) => `O${i}`) }).options.length, 8);
  assert.match(questionText({ question: 'Who orders shelter?', kind: 'choice', options: ['Camp director', 'Parks director'], allowOther: true }), /You asked the member: "Who orders shelter\?" Options: Camp director; Parks director; or their own answer/);
});

test('a question Ranger asked goes back to the model with the member’s answer', () => {
  const msgs = toConverseMessages([
    { role: 'user', text: 'Write a lightning plan. Ask me what you need.' },
    { role: 'assistant', text: '', question: { question: 'Day camp or overnight?', kind: 'choice', options: ['Day camp', 'Overnight'] } },
    { role: 'user', text: 'Overnight' }
  ]);
  assert.equal(msgs.length, 3, 'a question with no lead-in text still counts as Ranger’s turn');
  assert.match(msgs[1].content[0].text, /You asked the member: "Day camp or overnight\?"/);
  assert.match(msgs[2].content[0].text, /<interview_so_far>[\s\S]*- Day camp or overnight\? → Overnight/);
  assert.equal(msgs[2].content.at(-1).text, 'Overnight');
});

test('a long interview: every earlier answer stays in view, so nothing is asked twice', () => {
  const history = [{ role: 'user', text: 'Write an emergency action plan. Ask me what you need.' }];
  for (let i = 1; i <= 20; i++) {
    history.push({ role: 'assistant', text: 'Thanks.', question: { question: `Question ${i}?`, kind: 'choice', options: ['Yes', 'No'] } });
    history.push({ role: 'user', text: i % 2 ? 'Yes' : 'No' });
  }
  const msgs = toConverseMessages(history);
  assert.equal(msgs.length, 41, 'all 20 questions and answers are sent (the old limit kept only 16 messages)');
  const recap = msgs.at(-1).content[0].text;
  for (let i = 1; i <= 20; i++) assert.ok(recap.includes(`- Question ${i}? → ${i % 2 ? 'Yes' : 'No'}`), `question ${i} in the recap`);
  assert.match(recap, /Don't ask any of these again/);
});

test('answering Ranger’s question is recognised once, and only for the question it asked', async () => {
  const { rememberQuestion, takeAnswer } = await import('../src/store.mjs');
  const q = { question: 'Who orders shelter?', kind: 'choice', options: ['Camp director', 'Parks director'], allowOther: true };
  assert.equal(await takeAnswer('conv_ans_1', q), false, 'nothing asked yet');
  await rememberQuestion('conv_ans_1', q);
  assert.equal(await takeAnswer('conv_ans_1', { ...q, question: 'Something Ranger never asked?' }), false, 'a made-up question doesn’t count');
  assert.equal(await takeAnswer('conv_ans_2', q), false, 'another conversation doesn’t count');
  assert.equal(await takeAnswer('conv_ans_1', q), true);
  assert.equal(await takeAnswer('conv_ans_1', q), false, 'only once');
});

test('the chat route remembers the question it asked, so the answer is free of the daily question count', async () => {
  const { takeAnswer } = await import('../src/store.mjs');
  const first = await chatEvents({ conversationId: 'conv_q_2', form: 'camp', messages: [{ role: 'user', text: 'Write a water safety plan. Ask me what you need to know first.' }] });
  const q = first.find((e) => e.type === 'done').question;
  assert.equal(await takeAnswer('conv_q_2', q), true);
});

test('asking ends the turn: one question, no further model calls', async () => {
  let calls = 0;
  const turn = async ({ onText }) => {
    calls++;
    onText('Thanks.');
    return { stopReason: 'tool_use', usage: {}, content: [{ text: 'Thanks.' }, { toolUse: { toolUseId: 'q1', name: 'ask_member', input: { question: 'How many campers attend?', kind: 'text', placeholder: 'e.g. 60' } } }] };
  };
  const r = await runAgent({ history: [{ role: 'user', text: 'write a lightning plan' }], library, turn, emit: () => {} });
  assert.equal(calls, 1);
  assert.equal(r.text, 'Thanks.');
  assert.deepEqual(r.question, { question: 'How many campers attend?', kind: 'text', placeholder: 'e.g. 60' });
  assert.deepEqual(r.toolCalls, [{ name: 'ask_member', input: { question: 'How many campers attend?', kind: 'text' } }]);
});

test('a malformed question goes back to the model to fix', async () => {
  let calls = 0, sawError = null;
  const turn = async ({ messages, tools }) => {
    calls++;
    assert.ok(tools.some((t) => t.toolSpec.name === 'ask_member'), 'ask_member is always offered');
    if (calls === 1) return { stopReason: 'tool_use', usage: {}, content: [{ toolUse: { toolUseId: 'q1', name: 'ask_member', input: { question: 'Pick one', kind: 'choice', options: ['Only'] } } }] };
    sawError = messages.at(-1).content[0].toolResult.content[0].json.error;
    return { stopReason: 'tool_use', usage: {}, content: [{ toolUse: { toolUseId: 'q2', name: 'ask_member', input: { question: 'Pick one', kind: 'choice', options: ['A', 'B'] } } }] };
  };
  const r = await runAgent({ history: [{ role: 'user', text: 'hi' }], library, turn, emit: () => {} });
  assert.equal(calls, 2);
  assert.match(sawError, /at least two options/);
  assert.deepEqual(r.question.options, ['A', 'B']);
});

test('a question asked when time is up still reaches the member', async () => {
  let n = 0, t = 0;
  const turn = async () => {
    n++;
    if (n === 1) return { stopReason: 'tool_use', usage: {}, content: [{ toolUse: { toolUseId: 'a', name: 'search_law', input: { query: 'x' } } }] };
    return { stopReason: 'tool_use', usage: {}, content: [{ toolUse: { toolUseId: 'b', name: 'ask_member', input: { question: 'Is there a pool?', kind: 'choice', options: ['Yes', 'No'] } } }] };
  };
  const r = await runAgent({ history: [{ role: 'user', text: 'q' }], library, turn, emit: () => {}, timeBudgetMs: 5, now: () => (t += 10) });
  assert.equal(r.question.question, 'Is there a pool?');
});

test('Ranger is told to ask one question at a time, in the locked rules', () => {
  const p = buildSystemPrompt({ form: 'camp', guidance: 'OMAG custom guidance only.' });
  assert.match(p, /# Asking the member questions\n- Ask one question at a time, with the ask_member tool, then stop and wait for the answer/);
  assert.match(p, /Never ask the same thing twice\. .*<interview_so_far>/);
  assert.match(p, /Ask only what changes your answer or the document\..*\[brackets\]/);
  assert.doesNotMatch(p, /two to four|a few related questions at a time|ask_choice/);
});

test('chat: the question card comes back, and the answer moves on to the document', async () => {
  const first = await chatEvents({ conversationId: 'conv_q_1', form: 'camp', messages: [{ role: 'user', text: 'Please write a water safety plan for Camp Hope in the Town of Hope. Ask me what you need to know first.' }] });
  const done = first.find((e) => e.type === 'done');
  assert.equal(done.question.kind, 'multi');
  assert.deepEqual(done.question.options, ['Swimming', 'Boating or canoeing', 'Hiking and trails', 'Field trips']);
  assert.ok(!done.draft);

  const second = await chatEvents({ conversationId: 'conv_q_1', form: 'camp', messages: [
    { role: 'user', text: 'Please write a water safety plan for Camp Hope in the Town of Hope. Ask me what you need to know first.' },
    { role: 'assistant', text: 'Happy to. First, one question.', question: done.question },
    { role: 'user', text: 'Swimming and Boating or canoeing' }
  ] });
  const d2 = second.find((e) => e.type === 'done');
  assert.ok(d2.draft, 'the answer leads on to the document');
  assert.equal(d2.draft.subtitle, 'Camp Hope, Town of Hope, Oklahoma');
});

test('saved settings with the old welcome text show the one-question-at-a-time wording', async () => {
  const { kv } = await import('../src/storage.mjs');
  const { getConfig } = await import('../src/config.mjs');
  await kv.put({ pk: 'CONFIG', sk: 'settings', welcomeText: "I'm OMAG's AI assistant for the Oklahoma camp safety law (HB 1675). I can help you find which of your facilities and programs may be covered, and write the plans, policies and forms your camp needs. I'll ask about your camp a few questions at a time, then write each document from scratch for you." });
  assert.match((await getConfig({ fresh: true })).settings.welcomeText, /one question at a time/);
  await kv.put({ pk: 'CONFIG', sk: 'settings', welcomeText: 'OMAG’s own words.' });
  assert.equal((await getConfig({ fresh: true })).settings.welcomeText, 'OMAG’s own words.', 'custom text is left alone');
});
