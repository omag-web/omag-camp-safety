// One chat turn: research with tools, then stream the answer.

import { converseTurn } from './model.mjs';
import { TOOL_SPECS, runTool } from './tools.mjs';
import { WRITE_DOCUMENT_SPEC, GET_SAMPLE_SPEC, validateDraft, currentDraftBlock } from './drafts.mjs';
import { metric } from './metrics.mjs';
import { attachmentBlock } from './attachments.mjs';
import { buildSystemPrompt, FORMS } from './prompt.mjs';

const MAX_TOOL_ROUNDS = 8;
const TIME_BUDGET_MS = 240_000;   // stop researching after 4 minutes so a document still finishes inside Lambda's 10-minute limit
const MAX_TOKENS = 16_000;        // room for reasoning plus a full policy document

/** Errors where trying a different model makes sense (throttling, model outages, a retired or unavailable model). */
export function isModelFailure(e) {
  const n = e?.name || '';
  if (/Throttling|TooManyRequests|ServiceUnavailable|ModelNotReady|ModelTimeout|ModelError|InternalServer|ResourceNotFound|ModelStreamError|TimeoutError/.test(n)) return true;
  if (n === 'AccessDeniedException' && /model/i.test(e.message || '')) return true;
  if (n === 'ValidationException' && /model|end of life|not supported|deprecated|inference profile/i.test(e.message || '')) return true;
  return /ECONNRESET|ETIMEDOUT|socket hang up/i.test(e?.code || e?.message || '');
}
const MAX_HISTORY = 16;
const MAX_MSG_CHARS = 6000;

/** Validates and converts the client's [{role, text}] history into Converse messages. */
export function toConverseMessages(history) {
  if (!Array.isArray(history) || !history.length) throw new Error('messages must be a non-empty array');
  const msgs = history
    .slice(-MAX_HISTORY)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({ role: m.role, content: [
      // Files the member attached come first, each marked as the member's document (see attachments.mjs).
      ...(m.role === 'user' && Array.isArray(m.attachments) ? m.attachments.map((a) => ({ text: attachmentBlock(a) })) : []),
      // The document Ranger wrote that the member is looking at, so they can ask for changes.
      ...(m.role === 'user' && m.draft ? draftBlock(m.draft) : []),
      { text: m.text.slice(0, MAX_MSG_CHARS) }
    ] }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  // Merge consecutive same-role messages (Converse requires alternation).
  const out = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      for (const blk of m.content) {
        const last = prev.content[prev.content.length - 1];
        if (last?.text !== undefined && blk.text !== undefined) last.text += '\n\n' + blk.text;
        else prev.content.push(blk);
      }
    }
    else out.push(m);
  }
  if (!out.length || out[out.length - 1].role !== 'user') throw new Error('last message must be from the user');
  return out;
}

function draftBlock(d) {
  try { return [{ text: currentDraftBlock(validateDraft(d)) }]; } catch { return []; }
}

/** Ids in [[...]] markers. */
export function markerIds(text) {
  return [...String(text).matchAll(/\[\[([^\]\n]{1,40})\]\]/g)].map((m) => m[1].trim());
}

/**
 * Runs the research-and-answer loop.
 * emit(event) receives {type:'status'|'text', ...} as things happen.
 * Returns { text, citations, usage, toolCalls }.
 */
export async function runAgent({ history, form, city, library, emit = () => {}, turn = converseTurn, guidance, modelId, fallbackModelId, templates = [], loadSample, timeBudgetMs = TIME_BUDGET_MS, now = Date.now }) {
  const started = now();
  let activeModel = modelId;
  let fellBack = false;
  /** One model call; if the main model fails, switch to the backup model for the rest of this answer. */
  const callModel = async (args, onText, onRestart = () => {}) => {
    let streamed = false;
    const wrapped = (d) => { streamed = true; onText(d); };
    try {
      return await turn({ ...args, modelId: activeModel, onText: wrapped });
    } catch (e) {
      if (fellBack || !fallbackModelId || fallbackModelId === activeModel || !isModelFailure(e)) throw e;
      console.warn(`Model ${activeModel} failed (${e.name}: ${e.message}); using backup model ${fallbackModelId}`);
      metric('ModelFallback');
      fellBack = true; activeModel = fallbackModelId;
      if (streamed) { emit({ type: 'reset' }); onRestart(); }
      return await turn({ ...args, modelId: activeModel, onText });
    }
  };
  const system = buildSystemPrompt({ form: FORMS[form] ? form : undefined, city, guidance, omagDocs: library.omagTitles || [], templates });
  const tools = [...TOOL_SPECS, WRITE_DOCUMENT_SPEC, ...(templates.length && loadSample ? [GET_SAMPLE_SPEC] : [])];
  const drafts = [];
  // Writing a document produces no text for a while, so say what's happening.
  const onToolStart = (name) => { if (name === 'write_document') emit({ type: 'status', text: 'Writing your document. Longer documents take a few minutes' }); };
  const messages = toConverseMessages(history);
  const seen = new Set();          // section ids the model has read this turn
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
  const toolCalls = [];
  let finalText = '';

  // Sections cited earlier in the conversation stay citable.
  for (const m of history) if (m.role === 'assistant') markerIds(m.text).forEach((id) => library.get(id) && seen.add(library.normalizeId(id)));

  let outOfTime = false;
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const lastRound = round === MAX_TOOL_ROUNDS || outOfTime;
    let turnText = '';
    const res = await callModel({ system, messages, tools, maxTokens: MAX_TOKENS, onToolStart }, (d) => { turnText += d; emit({ type: 'text', text: d }); }, () => { turnText = ''; });
    for (const k of Object.keys(usage)) usage[k] += res.usage?.[k] || 0;
    messages.push({ role: 'assistant', content: res.content });

    const uses = res.content.filter((b) => b.toolUse);
    // Out of rounds or time, a finished document is still kept; research calls are not run.
    const writes = uses.filter((u) => u.toolUse.name === 'write_document');
    if (lastRound && writes.length) {
      for (const { toolUse } of writes) {
        await runTool(toolUse.name, toolUse.input, library, { seen, drafts });
        toolCalls.push({ name: toolUse.name, input: { title: String(toolUse.input?.title || '').slice(0, 200) } });
      }
      finalText = turnText || (drafts.length
        ? 'Here’s the draft I wrote for your camp. Look for anything in [brackets] that you still need to fill in or decide, and review it with your municipal attorney, county emergency management or OMAG before you use it. Tell me what you’d like changed.'
        : '');
      if (finalText && !turnText) emit({ type: 'text', text: finalText });
      if (finalText) break;
    }
    if (res.stopReason !== 'tool_use' || !uses.length || lastRound) {
      finalText = turnText;
      if (lastRound && uses.length && !turnText) {
        finalText = "I wasn't able to finish researching that. Could you rephrase or narrow the question?";
        emit({ type: 'text', text: finalText });
      }
      break;
    }
    // Text written before a tool call is a preamble; tell the client to clear it.
    if (turnText) emit({ type: 'reset' });

    const results = [];
    for (const { toolUse } of uses) {
      const r = await runTool(toolUse.name, toolUse.input, library, { templates, seen, drafts, loadSample });
      r.ids.forEach((id) => seen.add(id));
      // Logs keep a document's title, not its text.
      toolCalls.push({ name: toolUse.name, input: toolUse.name === 'write_document' ? { title: String(toolUse.input?.title || '').slice(0, 200) } : toolUse.input });
      emit({ type: 'status', text: r.status });
      results.push({ toolResult: { toolUseId: toolUse.toolUseId, content: [{ json: r.result }] } });
    }
    // Running long: tell the model to answer now from what it has read.
    if (!outOfTime && now() - started > timeBudgetMs) {
      outOfTime = true;
      metric('TimeBudgetReached');
      results.push({ text: 'Time is almost up. Write your answer now using only the sections you have already read, and do not call search_law, get_sections or get_sample again. If the member asked for a document, call write_document now with the complete document. If something is still uncertain, say so and suggest the member confirm with county emergency management, their municipal attorney or OMAG.' });
    }
    messages.push({ role: 'user', content: results });
  }

  // Only sections that exist and that the model actually read become citations.
  const citations = [];
  const unread = [];
  for (const raw of new Set(markerIds(finalText))) {
    const s = library.get(raw);
    if (s && seen.has(s.id)) citations.push({ marker: raw, id: s.id, cite: s.cite, heading: s.heading });
    else unread.push(raw);
  }
  // The last version written this turn is the one the member sees.
  const draft = drafts[drafts.length - 1];
  return { text: finalText, citations, unread, usage, toolCalls, draft, model: activeModel, fellBack };
}
