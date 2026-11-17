// Lambda entry point (Function URL with response streaming).
//
// Public
//   GET  /health                 → status and library info
//   GET  /config                 → member-facing settings (welcome text, starters, disclaimer)
//   GET  /auth-config            → Cognito ids for the admin sign-in page
//   GET  /source?id=11-12-106    → one section's full text (for citation chips)
//   POST /chat                   → streams NDJSON events: status | text | reset | done | error
//   POST /feedback               → thumbs up/down on an answer
//   POST /contact                → "Talk to OMAG" message
//   POST /documents/docx         → Word file for a document Ranger wrote: { draft, municipality } → { filename, data (base64 .docx) }
// Admin (signed in; see admin.mjs)
//   /admin/*                     → instructions, documents, settings, conversations, library
//   POST /admin/preview          → like /chat, but with the draft instructions
// Scheduled
//   { rangerTask: "refresh-library" } from EventBridge → pull the latest statute library, re-read OMAG websites,
//                                     and update token prices from AWS's price list
//
// CORS is handled by the Function URL configuration in template.yaml.

import { getLibrary, refreshLibrary } from './library.mjs';
import { runAgent } from './agent.mjs';
import { getConfig, publicSettings } from './config.mjs';
import { kv } from './storage.mjs';
import { requireAdmin, authConfig } from './auth.mjs';
import { matchAdmin } from './admin.mjs';
import { refreshWebsites } from './docs.mjs';
import { refreshPrices } from './pricing.mjs';
import { checkRateLimit, checkDocLimit, checkAttachLimit, logTurn, logDocument, newTurnId, saveFeedback, saveContact } from './store.mjs';
import { readAttachment, cleanAttachments } from './attachments.mjs';
import { validateDraft, draftToDocx, draftFilename } from './drafts.mjs';
import { redact } from './privacy.mjs';

const ID = /^[A-Za-z0-9_-]{6,64}$/;
const FORM_KEYS = ['camp', 'facility', 'campground', 'unsure'];   // program types (see prompt.mjs FORMS)

export const handler = awslambda.streamifyResponse(async (event, stream) => {
  if (event?.rangerTask === 'refresh-library') {
    const result = await refreshLibrary();
    console.log('scheduled library refresh', result);
    const sites = await refreshWebsites().catch((e) => { console.error('website refresh failed', e); return []; });
    if (sites.length) console.log('scheduled website refresh', sites);
    const prices = await refreshPrices().catch((e) => ({ ok: false, message: e.message }));
    console.log('scheduled price check', prices);
    stream.write(JSON.stringify(result));
    stream.end();
    return;
  }
  const method = event.requestContext?.http?.method || 'GET';
  const path = (event.rawPath || '/').replace(/\/+$/, '') || '/';
  const ip = event.requestContext?.http?.sourceIp || '';
  try {
    if (method === 'GET' && path === '/health') return json(stream, 200, await health());
    if (method === 'GET' && path === '/config') return json(stream, 200, publicSettings((await getConfig()).settings), { 'Cache-Control': 'public, max-age=60' });
    if (method === 'GET' && path === '/auth-config') return json(stream, 200, authConfig());
    if (method === 'GET' && path === '/source') return await source(stream, event.queryStringParameters?.id);
    if (method === 'POST' && path === '/chat') return await chat(stream, parse(event, 600_000), ip);
    if (method === 'POST' && path === '/attach') return await attach(stream, parse(event, 5_800_000), ip);
    if (method === 'POST' && path === '/feedback') return await feedback(stream, parse(event));
    if (method === 'POST' && path === '/contact') return await contact(stream, parse(event), ip);
    if (method === 'POST' && path === '/documents/docx') return await draftDoc(stream, parse(event, 400_000), ip);
    if (path.startsWith('/admin/')) {
      const admin = await requireAdmin(event);
      if (method === 'POST' && path === '/admin/preview') return await chat(stream, parse(event), ip, { admin });
      const route = matchAdmin(method, path);
      if (!route) return json(stream, 404, { error: 'Not found' });
      const body = method === 'GET' ? {} : parse(event);
      const result = await route.fn({ admin, params: route.params, body, query: event.queryStringParameters || {} });
      return json(stream, 200, result ?? { ok: true });
    }
    return json(stream, 404, { error: 'Not found' });
  } catch (e) {
    if (!e.status) console.error(e);
    // Signed-in admins see what actually failed (members only ever see the generic message).
    const detail = !e.status && path.startsWith('/admin/') && e.name !== 'Error' ? ` (${e.name}: ${String(e.message || '').slice(0, 300)})` : '';
    return json(stream, e.status || 500, { error: e.status ? e.message : `Something went wrong.${detail}` });
  }
});

/** Request body as JSON. Most requests are small; attachments (a base64 file) and chats that carry one are bigger. */
function parse(event, max = 200_000) {
  let body = event.body || '';
  if (event.isBase64Encoded) body = Buffer.from(body, 'base64').toString('utf8');
  if (body.length > max) throw Object.assign(new Error(max > 1e6 ? 'That file is over 4 MB. Attach just the sections you need, or save it as a smaller PDF.' : 'Request too large'), { status: 413 });
  try { return JSON.parse(body || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function json(stream, statusCode, obj, headers = {}) {
  const s = awslambda.HttpResponseStream.from(stream, { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
  s.write(JSON.stringify(obj));
  s.end();
}

async function health() {
  const [lib, cfg] = await Promise.all([getLibrary(), getConfig()]);
  return {
    ok: true,
    model: process.env.MODEL_MODE === 'mock' ? 'mock' : cfg.settings.modelId,
    library: { sections: lib.sections.length, statutes: lib.statuteCount, omag: lib.sections.length - lib.statuteCount, builtAt: lib.builtAt, origin: lib.origin }
  };
}

async function source(stream, id) {
  const s = id && (await getLibrary()).get(String(id).slice(0, 60));
  if (!s) return json(stream, 404, { error: 'Section not found' });
  return json(stream, 200, { id: s.id, cite: s.cite, heading: s.heading, source: s.source, url: s.url, text: s.text, history: s.history }, { 'Cache-Control': 'public, max-age=300' });
}

/** Member chat, or (with opts.admin) an admin preview using the draft instructions. */
async function chat(stream, body, ip, opts = {}) {
  const { conversationId, browserId, city, form } = body;
  // Second line of defense (the member page checks first): Social Security, card, account, license
  // numbers and birth dates never reach the model or the logs.
  const removed = [];
  const messages = Array.isArray(body.messages) ? cleanAttachments(body.messages.map((m) => {
    const r = redact(m?.text);
    removed.push(...r.removed);
    return { role: m?.role, text: r.text, attachments: m?.attachments, draft: m?.role === 'user' ? m?.draft : undefined };
  })) : body.messages;
  if (removed.length) console.log('removed personal details from a chat request:', [...new Set(removed)].join(', '));
  if (!ID.test(String(conversationId || ''))) return json(stream, 400, { error: 'conversationId required' });
  if (!Array.isArray(messages) || !messages.length || messages.length > 40) return json(stream, 400, { error: 'messages required' });
  const question = String(messages[messages.length - 1]?.text || '');
  if (!question.trim() || question.length > 4000) return json(stream, 400, { error: 'Question must be 1–4,000 characters.' });

  const cfg = await getConfig();
  let guidance = cfg.guidance;
  if (opts.admin) {
    if (typeof body.guidance === 'string' && body.guidance.trim()) guidance = body.guidance.slice(0, 20000);
    else if (body.useDraft !== false) guidance = (await kv.get('CONFIG', 'guidance#draft'))?.text ?? guidance;
  } else {
    const limit = await checkRateLimit(ip, { perIp: cfg.settings.dailyLimitPerIp, global: cfg.settings.dailyLimitGlobal });
    if (!limit.ok) return json(stream, 429, { error: limit.reason });
  }

  const out = awslambda.HttpResponseStream.from(stream, {
    statusCode: 200,
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }
  });
  const emit = (ev) => out.write(JSON.stringify(ev) + '\n');
  const turnId = newTurnId();
  const started = Date.now();
  const modelId = cfg.settings.modelId;
  let result = null;
  let error = null;
  // Writing a long document can go minutes without new text; a small ping keeps the connection open.
  const ping = setInterval(() => emit({ type: 'ping' }), 15_000);
  try {
    emit({ type: 'status', text: 'Reading your question' });
    result = await runAgent({
      history: messages, form, city: city ? String(city).slice(0, 120) : undefined,
      library: await getLibrary(), emit, guidance, modelId, fallbackModelId: cfg.settings.fallbackModelId
      // OMAG samples later: pass `templates: await memberTemplates(form)` and
      // `loadSample: (id) => sampleText(id, form, { getTemplate, pickVariant, getBlob, extractText })`
      // (both from templates.mjs / drafts.mjs, as in Pip's handler) to offer get_sample.
    });
    emit({ type: 'done', turnId, citations: result.citations, unread: result.unread, ...(result.draft ? { draft: result.draft } : {}) });
  } catch (e) {
    console.error('chat failed', e);
    error = e.name || 'Error';
    emit({ type: 'error', message: friendlyError(e) });
  } finally { clearInterval(ping); }
  try {
    await logTurn({
      conversationId, turnId, browserId, ip, city, form, question,
      attachments: (messages[messages.length - 1]?.attachments || []).map((a) => a.name),
      answer: result?.text, citations: result?.citations, unread: result?.unread,
      usage: result?.usage, toolCalls: result?.toolCalls, latencyMs: Date.now() - started,
      model: process.env.MODEL_MODE === 'mock' ? 'mock' : (result?.model || modelId), error, preview: !!opts.admin
    });
  } catch (e) { console.error('log failed', e); }
  out.end();
}

function friendlyError(e) {
  if (/Throttling|TooManyRequests/i.test(e.name || '')) return 'Ranger is busy right now. Please try again in a minute.';
  if (/AccessDenied/i.test(e.name || '')) return 'Ranger is not connected to its AI model yet (model access). Please let OMAG know.';
  if (/messages|last message/.test(e.message || '')) return e.message;
  return 'Something went wrong while answering. Please try again.';
}

/** A member attaches a file: read its text and send it back (the file itself isn't kept). */
async function attach(stream, body, ip) {
  const limit = await checkAttachLimit(ip);
  if (!limit.ok) return json(stream, 429, { error: limit.reason });
  const r = await readAttachment(body || {});
  if (r.removed.length) console.log('removed personal details from an attachment:', r.removed.join(', '));
  return json(stream, 200, r);
}

async function feedback(stream, body) {
  const { conversationId, turnId, rating, note } = body;
  if (!ID.test(String(conversationId || '')) || !/^TURN#/.test(String(turnId || '')) || !['up', 'down'].includes(rating)) return json(stream, 400, { error: 'Invalid feedback' });
  const ok = await saveFeedback({ conversationId, turnId, rating, note });
  return json(stream, ok ? 200 : 404, { ok });
}

/** Word file for a document Ranger wrote in chat. The draft comes back from the browser, so it's checked again. */
async function draftDoc(stream, body, ip) {
  let draft;
  try { draft = validateDraft(body.draft); } catch (e) { return json(stream, 400, { error: e.message }); }
  const limit = await checkDocLimit(ip);
  if (!limit.ok) return json(stream, 429, { error: limit.reason });
  const municipality = String(body.municipality || '').slice(0, 120);
  const data = await draftToDocx(draft);
  try {
    await logDocument({ templateId: 'custom', title: draft.title, form: FORM_KEYS.includes(body.form) ? body.form : undefined, city: municipality, browserId: body.browserId, ip, blanks: (draftText(draft).match(/\[[^\]\n]{2,80}\]/g) || []).length, conversationId: ID.test(String(body.conversationId || '')) ? body.conversationId : undefined });
  } catch (e) { console.error('doc log failed', e); }
  return json(stream, 200, { filename: draftFilename(draft, municipality), data: data.toString('base64') });
}
const draftText = (d) => d.blocks.map((b) => b.text || b.items.join('\n')).join('\n');

async function contact(stream, body, ip) {
  const { conversationId, form } = body;
  const city = String(body.city || '').trim().slice(0, 120) || undefined;
  // The member's name and phone are how OMAG follows up, so they're kept as given (not redacted).
  const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const phone = String(body.phone || '').trim().slice(0, 30);
  if (name.length < 2) return json(stream, 400, { error: 'Please add your name.' });
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return json(stream, 400, { error: 'Please add a phone number with area code.' });
  const note = redact(body.note).text, transcript = redact(body.transcript).text;
  if (!String(note || '').trim() && !String(transcript || '').trim()) return json(stream, 400, { error: 'Add a note' });
  await saveContact({ conversationId, name, phone, city, form, note, transcript, ip });
  return json(stream, 200, { ok: true });
}
