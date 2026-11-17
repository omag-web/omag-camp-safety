import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installShim, makeResponseStream } from '../scripts/lambda-shim.mjs';

installShim();
process.env.MODEL_MODE = 'mock';
process.env.LOCAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'ranger-perms-'));
delete process.env.TABLE_NAME; delete process.env.DATA_BUCKET; delete process.env.USER_POOL_ID;
const { handler } = await import('../src/handler.mjs');
const { areaFor, getAreas, setAreas, AREA_KEYS, _clearCache } = await import('../src/permissions.mjs');

async function call(method, path, { body } = {}) {
  const stream = makeResponseStream();
  await handler({ rawPath: path, headers: {}, body: body ? JSON.stringify(body) : undefined, requestContext: { http: { method, sourceIp: '203.0.113.20' } } }, stream);
  await stream.done;
  const r = stream.result();
  let json; try { json = JSON.parse(r.body); } catch {}
  return { ...r, json };
}

test('every admin page belongs to an area', () => {
  assert.equal(areaFor('GET', '/admin/me'), null);
  for (const [p, a] of [['/admin/analytics', 'reports'], ['/admin/overview', 'reports'], ['/admin/analytics/export', 'reports'],
    ['/admin/guidance/draft', 'content'], ['/admin/docs/x1', 'content'], ['/admin/samples', 'content'], ['/admin/library/rebuild', 'content'], ['/admin/checks/run', 'content'], ['/admin/preview', 'content'],
    ['/admin/conversations', 'conversations'], ['/admin/conversations/c_1', 'conversations'], ['/admin/contacts', 'conversations'],
    ['/admin/settings', 'settings'], ['/admin/recipients/messages', 'settings'], ['/admin/prices/refresh', 'settings'],
    ['/admin/admins', 'admins'], ['/admin/admins/u1/access', 'admins'], ['/admin/something-new', 'admins']]) {
    assert.equal(areaFor('GET', p), a, p);
  }
});

test('admins from before access levels keep everything; changes are checked', async () => {
  assert.deepEqual(await getAreas('old-admin'), AREA_KEYS, 'no record = full access');
  const me = { username: 'boss', email: 'boss@omag.org' };
  const list = [{ username: 'boss', enabled: true }, { username: 'sam', enabled: true }];
  assert.deepEqual(await setAreas('sam', ['conversations', 'reports', 'bogus'], me, list), ['reports', 'conversations']);
  assert.deepEqual(await getAreas('sam'), ['reports', 'conversations']);
  await assert.rejects(setAreas('sam', [], me, list), /at least one area/);
  await assert.rejects(setAreas('boss', ['reports'], me, list), /away from yourself/);
  // sam can't remove the last other access-manager either
  await assert.rejects(setAreas('boss', ['reports'], { username: 'sam', email: 'sam@omag.org' }, list), /At least one admin must keep the Admins area/);
  _clearCache();
});

test('a limited admin only reaches their areas, and sees them in /admin/me', async () => {
  process.env.LOCAL_ADMIN_AREAS = 'reports,content';
  try {
    const me = await call('GET', '/admin/me');
    assert.deepEqual(me.json.areas, ['reports', 'content']);
    assert.equal(me.json.allAreas.conversations.label, 'Conversations and messages');
    assert.equal((await call('GET', '/admin/analytics')).statusCode, 200);
    assert.equal((await call('GET', '/admin/samples')).statusCode, 200);
    for (const [m, p] of [['GET', '/admin/conversations'], ['GET', '/admin/contacts'], ['GET', '/admin/settings'], ['PUT', '/admin/settings'], ['GET', '/admin/admins'], ['POST', '/admin/admins']]) {
      const r = await call(m, p, { body: m === 'GET' ? undefined : {} });
      assert.equal(r.statusCode, 403, `${m} ${p}`);
      assert.match(r.json.error, /You don’t have access to/);
    }
  } finally { delete process.env.LOCAL_ADMIN_AREAS; }
});

test('admins page: invite with chosen areas, change access, and never lose the last access-manager', async () => {
  const { _resetLocal } = await import('../src/admins.mjs');
  _resetLocal();
  let r = await call('POST', '/admin/admins', { body: { email: 'reports@omag.org', areas: ['reports'] } });
  assert.equal(r.statusCode, 200, JSON.stringify(r.json));
  const rep = r.json.admins.find((a) => a.email === 'reports@omag.org');
  assert.deepEqual(rep.areas, ['reports']);
  assert.deepEqual(r.json.admins.find((a) => a.you).areas, AREA_KEYS);
  assert.equal(r.json.allAreas.admins.label, 'Admins');

  r = await call('POST', '/admin/admins', { body: { email: 'default@omag.org' } });
  assert.deepEqual(r.json.admins.find((a) => a.email === 'default@omag.org').areas, ['reports', 'content'], 'default for new admins');
  assert.equal((await call('POST', '/admin/admins', { body: { email: 'none@omag.org', areas: [] } })).statusCode, 400, 'at least one area');
  assert.ok(!(await call('GET', '/admin/admins')).json.admins.some((a) => a.email === 'none@omag.org'), 'no half-made admin');

  r = await call('PUT', `/admin/admins/${rep.username}/access`, { body: { areas: ['reports', 'conversations'] } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json.admins.find((a) => a.username === rep.username).areas, ['reports', 'conversations']);
  assert.match(r.json.message, /within a minute/);
  const me = r.json.admins.find((a) => a.you);
  assert.equal((await call('PUT', `/admin/admins/${me.username}/access`, { body: { areas: ['reports'] } })).statusCode, 400, 'not from yourself');

  // Give reports@ the Admins area, then they could manage; turning off or removing the only other access-manager is refused.
  await call('PUT', `/admin/admins/${rep.username}/access`, { body: { areas: ['admins'] } });
  r = await call('DELETE', `/admin/admins/${rep.username}`);
  assert.equal(r.statusCode, 200, 'local-dev still manages access, so removing is fine');
  assert.ok(!r.json.admins.some((a) => a.username === rep.username));
});
