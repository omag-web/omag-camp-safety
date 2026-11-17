// What each admin can see and do in the admin panel. Each admin has a set of areas;
// the server checks them on every admin request (the page also hides what they can't use).
//
//   pk ADMINACCESS  sk <cognito username>  { areas: [...], updatedAt, updatedBy }
//
// An admin with no record has every area: everyone who was an admin before access
// levels existed keeps full access until someone changes it.

import { kv } from './storage.mjs';

export const AREAS = {
  reports: { label: 'Reports', covers: 'Analytics: usage, topics, cities, ratings and cost' },
  content: { label: 'Content', covers: 'Instructions, OMAG documents, sample documents, statute library and answer checks' },
  conversations: { label: 'Conversations and messages', covers: 'Members’ conversations and their “Talk to OMAG” notes' },
  settings: { label: 'Settings', covers: 'Limits, AI model and prices, welcome screen, privacy notice, retention and email lists' },
  admins: { label: 'Admins', covers: 'Invite, remove and change other admins’ access' }
};
export const AREA_KEYS = Object.keys(AREAS);
/** What a newly invited admin gets unless the inviter picks otherwise. */
export const DEFAULT_AREAS = ['reports', 'content'];

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

/** Which area an admin request belongs to. null = open to every admin (who am I, my own two-step). */
export function areaFor(method, path) {
  if (path === '/admin/me') return null;
  if (/^\/admin\/(analytics|overview)\b/.test(path)) return 'reports';
  if (/^\/admin\/(guidance|docs|samples|samples-migrate|library|checks|preview)\b/.test(path)) return 'content';
  if (/^\/admin\/(conversations|contacts)\b/.test(path)) return 'conversations';
  if (/^\/admin\/(settings|recipients|prices)\b/.test(path)) return 'settings';
  if (/^\/admin\/admins\b/.test(path)) return 'admins';
  return 'admins';   // anything new and unlisted stays with full admins until it's placed
}

export function cleanAreas(list) {
  return AREA_KEYS.filter((k) => Array.isArray(list) && list.includes(k));
}

/* ---------- reading (cached briefly, like the "still active" check) ---------- */
const cache = new Map();
const TTL = 60_000;

/** The areas this admin can use. */
export async function getAreas(username) {
  if (!username || username === 'local-dev') return [...AREA_KEYS];
  const hit = cache.get(username);
  if (hit && Date.now() - hit.at < TTL) return hit.areas;
  const rec = await kv.get('ADMINACCESS', username);
  const areas = rec ? cleanAreas(rec.areas) : [...AREA_KEYS];
  cache.set(username, { areas, at: Date.now() });
  return areas;
}

/** Areas for many admins at once (the Admins page). */
export async function areasFor(usernames) {
  const out = {};
  await Promise.all(usernames.map(async (u) => { out[u] = await getAreas(u); }));
  return out;
}

/* ---------- changing ---------- */

/**
 * Sets an admin's areas. Rules: at least one area; you can't take Admins away from yourself;
 * and at least one admin who is turned on must keep Admins, so nobody gets locked out.
 * admins = the current admin list (for the last-full-admin check).
 */
export async function setAreas(username, areas, me, admins) {
  const next = cleanAreas(areas);
  if (!next.length) throw err('Give them at least one area, or turn off their access instead.');
  if (username === me.username && !next.includes('admins')) throw err('You can’t take the Admins area away from yourself. Ask another admin to do it.');
  if (!next.includes('admins')) {
    const others = await Promise.all(admins.filter((a) => a.username !== username && a.enabled).map(async (a) => (await getAreas(a.username)).includes('admins')));
    if (!others.some(Boolean)) throw err('At least one admin must keep the Admins area, so someone can always manage access.');
  }
  await kv.put({ pk: 'ADMINACCESS', sk: username, areas: next, updatedAt: new Date().toISOString(), updatedBy: me.email });
  cache.delete(username);
  return next;
}

export async function forgetAreas(username) {
  await kv.del('ADMINACCESS', username);
  cache.delete(username);
}

export function _clearCache() { cache.clear(); }
