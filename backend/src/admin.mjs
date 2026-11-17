// /admin/* routes. Every route requires a signed-in admin (see auth.mjs).

import { requireAdmin } from './auth.mjs';
import { getConfig, getGuidanceState, saveDraft, discardDraft, publishDraft, restoreToDraft, saveSettings, MODELS, validateGuidance, DEFAULT_PRIVACY_NOTICE } from './config.mjs';
import { listDocs, createUpload, processDoc, updateDoc, deleteDoc, addWebsite, fetchWebsite } from './docs.mjs';
import { getLibrary, libraryStatus, refreshLibrary, librarySources, checkSources } from './library.mjs';
import { listTurns, getConversation, listContacts, usageStats } from './store.mjs';
import { analytics } from './analytics.mjs';
import { refreshPrices } from './pricing.mjs';
import { listSamples, getSample, createSample, updateSample, deleteSample, fileUploadUrl, attachFile, removeFile, VERSION_LABEL } from './samples.mjs';
import { listAdmins, inviteAdmin, resendAccess, setAdminEnabled, removeAdmin, resetMfa } from './admins.mjs';
import { saveSourcesConfig } from './sources.mjs';
import { AREAS, DEFAULT_AREAS, areasFor, setAreas, forgetAreas, getAreas, cleanAreas } from './permissions.mjs';
import { getJob, startJob } from './jobs.mjs';
import { getQuestions, saveQuestions, listRuns, getRun, FORMS, PASS_SHARE } from './checks.mjs';
import { listRecipients, addRecipient, removeRecipient, LISTS } from './notify.mjs';

const routes = [];
const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[A-Za-z0-9_\\-]+)') + '$'), fn });

on('GET', '/admin/me', async ({ admin }) => ({ email: admin.email, dev: !!admin.dev, mfaRequired: process.env.ADMIN_MFA_REQUIRED === 'true', areas: admin.areas, allAreas: AREAS }));

on('GET', '/admin/overview', async () => {
  const [stats, library, docs, cfg] = await Promise.all([usageStats({ days: 30 }), libraryStatus(), listDocs(), getConfig({ fresh: true })]);
  return { stats, library, docs: { total: docs.length, enabled: docs.filter((d) => d.enabled).length }, guidance: cfg.guidanceMeta, model: MODELS[cfg.settings.modelId] || cfg.settings.modelId };
});

on('GET', '/admin/analytics', async ({ query }) => {
  const [lib, cfg] = await Promise.all([getLibrary(), getConfig({ fresh: true })]);
  return analytics({
    days: query.days,
    labels: (id) => lib.get(id)?.cite,
    prices: { in: cfg.settings.priceInputPerM, out: cfg.settings.priceOutputPerM, cacheRead: cfg.settings.priceCacheReadPerM }
  });
});
on('GET', '/admin/analytics/export', async ({ query }) => ({
  turns: (await listTurns({ days: Math.min(Number(query.days) || 30, 366), limit: 20000 }))
    .map(({ browser, ...t }) => t)
}));

/* admins */
const withYou = async (admin, extra = {}) => {
  const list = await listAdmins();
  const areas = await areasFor(list.map((u) => u.username));
  return { ...extra, you: admin.username, allAreas: AREAS, defaultAreas: DEFAULT_AREAS, admins: list.map((u) => ({ ...u, areas: areas[u.username], you: u.username === admin.username || u.email === admin.email })) };
};
/** Turning off or removing someone must leave at least one other admin who can manage access. */
async function keepAnAccessAdmin(username, me) {
  if (username === me.username) return;   // acting on yourself is refused with its own message
  const list = await listAdmins();
  if (!(await getAreas(username)).includes('admins')) return;
  const others = await Promise.all(list.filter((u) => u.username !== username && u.enabled).map(async (u) => (await getAreas(u.username)).includes('admins')));
  if (!others.some(Boolean)) throw Object.assign(new Error('They’re the only other admin who can manage access. Give someone else the Admins area first.'), { status: 400 });
}
on('GET', '/admin/admins', async ({ admin }) => withYou(admin));
on('POST', '/admin/admins', async ({ body, admin }) => {
  // Check the areas before sending the invite, so a bad choice doesn't leave a half-made admin.
  const areas = cleanAreas(body?.areas ?? DEFAULT_AREAS);
  if (!areas.length) throw Object.assign(new Error('Choose at least one area for them.'), { status: 400 });
  const u = await inviteAdmin(body?.email);
  await setAreas(u.username, areas, admin, await listAdmins());
  console.log('admin invited', u.email, 'with', areas.join(','), 'by', admin.email);
  return withYou(admin, { message: `Invited ${u.email}. They'll get an email with a temporary password (good for 7 days).` });
});
on('PUT', '/admin/admins/:id/access', async ({ params, body, admin }) => {
  const list = await listAdmins();
  const target = list.find((u) => u.username === params.id);
  if (!target) throw Object.assign(new Error('That admin no longer exists.'), { status: 404 });
  const areas = await setAreas(params.id, body?.areas, admin, list);
  console.log('admin access changed', target.email, areas.join(','), 'by', admin.email);
  return withYou(admin, { message: `Updated what ${target.email} can see. It takes effect within a minute.` });
});
on('POST', '/admin/admins/:id/resend', async ({ params, admin }) => withYou(admin, await resendAccess(params.id)));
on('POST', '/admin/admins/:id/disable', async ({ params, admin }) => { await keepAnAccessAdmin(params.id, admin); const r = await setAdminEnabled(params.id, false, admin); console.log('admin disabled', params.id, 'by', admin.email); return withYou(admin, r); });
on('POST', '/admin/admins/:id/enable', async ({ params, admin }) => { const r = await setAdminEnabled(params.id, true, admin); console.log('admin enabled', params.id, 'by', admin.email); return withYou(admin, r); });
on('POST', '/admin/admins/:id/reset-mfa', async ({ params, admin }) => { const r = await resetMfa(params.id, admin); console.log('admin MFA reset', params.id, 'by', admin.email); return withYou(admin, r); });
on('DELETE', '/admin/admins/:id', async ({ params, admin }) => { await keepAnAccessAdmin(params.id, admin); const r = await removeAdmin(params.id, admin); await forgetAreas(params.id); console.log('admin removed', params.id, 'by', admin.email); return withYou(admin, r); });

/* sample documents (read by Ranger as a guide; see samples.mjs) */
const sampleMeta = { versions: VERSION_LABEL };
on('GET', '/admin/samples', async () => ({ samples: await listSamples(), ...sampleMeta }));
on('POST', '/admin/samples', async ({ body, admin }) => ({ sample: await createSample(body || {}, admin.email) }));
on('GET', '/admin/samples/:id', async ({ params }) => ({ sample: await getSample(params.id), ...sampleMeta }));
on('PUT', '/admin/samples/:id', async ({ params, body, admin }) => ({ sample: await updateSample(params.id, body || {}, admin.email) }));
on('DELETE', '/admin/samples/:id', async ({ params }) => { await deleteSample(params.id); return { samples: await listSamples() }; });
on('POST', '/admin/samples/:id/upload', async ({ params, body }) => fileUploadUrl(params.id, body || {}));
on('POST', '/admin/samples/:id/attach', async ({ params, body, admin }) => attachFile(params.id, body || {}, admin.email));
on('POST', '/admin/samples/:id/remove-file', async ({ params, body }) => ({ sample: await removeFile(params.id, String(body?.version || '')) }));

/* guidance */
on('GET', '/admin/guidance', async () => getGuidanceState());
on('PUT', '/admin/guidance/draft', async ({ body, admin }) => { await saveDraft(body.text, admin.email); return getGuidanceState(); });
on('DELETE', '/admin/guidance/draft', async () => { await discardDraft(); return getGuidanceState(); });
on('POST', '/admin/guidance/publish', async ({ body, admin }) => { await publishDraft(admin.email, body.note); return getGuidanceState(); });
on('POST', '/admin/guidance/restore', async ({ body, admin }) => { await restoreToDraft(String(body.id || ''), admin.email); return getGuidanceState(); });

/* settings */
const settingsExtra = { models: MODELS, privacyDefault: DEFAULT_PRIVACY_NOTICE };
on('GET', '/admin/settings', async () => ({ settings: (await getConfig({ fresh: true })).settings, ...settingsExtra }));
on('PUT', '/admin/settings', async ({ body, admin }) => {
  const before = (await getConfig({ fresh: true })).settings;
  let settings = await saveSettings(body || {}, admin.email);
  // New model, or automatic prices just turned on: look the prices up now rather than tomorrow.
  if (settings.autoPrices !== false && (settings.modelId !== before.modelId || before.autoPrices === false)) {
    await refreshPrices().catch((e) => console.error('price check failed', e));
    settings = (await getConfig({ fresh: true })).settings;
  }
  return { settings, ...settingsExtra };
});
on('POST', '/admin/prices/refresh', async () => ({ result: await refreshPrices(), settings: (await getConfig({ fresh: true })).settings }));

/* who gets Ranger's emails */
const allLists = async () => Object.fromEntries(await Promise.all(LISTS.map(async (l) => [l, await listRecipients(l)])));
on('GET', '/admin/recipients', async () => ({ lists: await allLists() }));
on('POST', '/admin/recipients/:list', async ({ params, body, admin }) => { const r = await addRecipient(params.list, body?.email); console.log(`${params.list} recipient added by`, admin.email); return { ...r, lists: await allLists() }; });
on('DELETE', '/admin/recipients/:list/:id', async ({ params, admin }) => { const r = await removeRecipient(params.list, params.id); console.log(`${params.list} recipient removed by`, admin.email); return { ...r, lists: await allLists() }; });

/* answer checks */
on('GET', '/admin/checks', async () => ({ questions: await getQuestions(), runs: await listRuns(), job: await getJob('run-checks'), forms: FORMS, passShare: PASS_SHARE }));
on('PUT', '/admin/checks/questions', async ({ body, admin }) => ({ questions: await saveQuestions(body?.questions, admin.email) }));
on('POST', '/admin/checks/run', async ({ admin }) => ({ job: await startJob('run-checks', admin.email) }));
on('GET', '/admin/checks/job', async () => ({ job: await getJob('run-checks') }));
on('GET', '/admin/checks/runs/:id', async ({ params }) => ({ run: await getRun(params.id) }));

/* documents */
on('GET', '/admin/docs', async () => ({ docs: await listDocs() }));
on('POST', '/admin/docs', async ({ body, admin }) => createUpload(body || {}, admin.email));
on('POST', '/admin/docs/web', async ({ body, admin }) => { const result = await addWebsite(body || {}, admin.email); return { result, docs: await listDocs() }; });
on('POST', '/admin/docs/:id/recheck', async ({ params }) => {
  let result;
  try { result = await fetchWebsite(params.id); } catch (e) { result = { error: e.message }; }
  return { result, docs: await listDocs() };
});
on('POST', '/admin/docs/:id/process', async ({ params }) => processDoc(params.id));
on('PUT', '/admin/docs/:id', async ({ params, body }) => { await updateDoc(params.id, body || {}); return { docs: await listDocs() }; });
on('DELETE', '/admin/docs/:id', async ({ params }) => { await deleteDoc(params.id); return { docs: await listDocs() }; });
on('GET', '/admin/docs/:id/sections', async ({ params }) => {
  const lib = await getLibrary();
  return { sections: lib.sections.filter((s) => s.id.startsWith(`omag-${params.id}-`)).map(({ id, cite, heading, text }) => ({ id, cite, heading, text })) };
});

/* conversations */
on('GET', '/admin/conversations', async ({ query }) => ({ turns: await listTurns({ days: Math.min(Number(query.days) || 14, 90), limit: 500 }) }));
on('GET', '/admin/conversations/:id', async ({ params }) => ({ turns: await getConversation(params.id) }));
on('GET', '/admin/contacts', async () => ({ contacts: await listContacts({ limit: 200 }) }));

/* library */
on('GET', '/admin/library', async () => libraryStatus());
on('GET', '/admin/library/sources', async () => librarySources());
on('POST', '/admin/library/check-sources', async () => checkSources());
on('PUT', '/admin/library/sources', async ({ body, admin }) => { await saveSourcesConfig(body || {}, admin.email); return librarySources(); });
on('POST', '/admin/library/rebuild', async ({ admin }) => ({ job: await startJob('build-library', admin.email) }));
on('GET', '/admin/library/build', async () => ({ job: await getJob('build-library') }));
on('POST', '/admin/library/refresh', async ({ body }) => ({ result: await refreshLibrary({ force: !!body?.force }), status: await libraryStatus() }));
on('POST', '/admin/library/search', async ({ body }) => {
  const lib = await getLibrary();
  const j = ['OK', 'US', 'OMAG'].includes(body?.jurisdiction) ? body.jurisdiction : undefined;
  return { results: lib.search(String(body?.query || '').slice(0, 300), { jurisdiction: j, limit: 15 }).map(({ id, cite, heading, jurisdiction, text }) => ({ id, cite, heading, jurisdiction, excerpt: text.slice(0, 300) })) };
});

/** Finds the route. Returns null if no admin route matches. */
export function matchAdmin(method, path) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.re);
    if (m) return { fn: r.fn, params: m.groups || {} };
  }
  return null;
}

export { validateGuidance };
