import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Library, tokenize } from '../src/library.mjs';

const lib = Library.load();

test('library loads with both jurisdictions', () => {
  assert.ok(lib.sections.length > 20);
  assert.ok(lib.sections.some((s) => s.jurisdiction === 'OK'));
  assert.ok(lib.sections.some((s) => s.jurisdiction === 'US'));
});

test('get() accepts ids and human citations', () => {
  assert.equal(lib.get('63-683.24E')?.cite, '63 O.S. § 683.24E');
  assert.equal(lib.get('63 O.S. § 683.24E')?.id, '63-683.24E');
  assert.equal(lib.get('63 O.S. 681')?.id, '63-681');
  assert.equal(lib.get('44 CFR 60.3')?.id, '44-CFR-60.3');
  assert.equal(lib.get('nope'), null);
});

test('every program type starting point exists in the library', async () => {
  const { FORMS } = await import('../src/prompt.mjs');
  for (const [form, f] of Object.entries(FORMS)) {
    for (const id of f.authority) assert.ok(lib.get(id), `${form}: ${id} missing from library`);
  }
});

const top = (q, opts) => lib.search(q, { limit: 5, ...opts }).map((s) => s.id);

test('search finds the right sections for typical questions', () => {
  assert.ok(top('site-specific hazard assessment review every three years', { jurisdiction: 'OK' }).includes('63-683.24E'));
  assert.ok(top('youth camp definition minors', { jurisdiction: 'OK' }).includes('63-683.24C'));
  assert.ok(top('two independent alert methods cellular', { jurisdiction: 'OK' }).includes('63-683.24G'));
  assert.ok(top('recreational campground emergency action plan annually', { jurisdiction: 'OK' }).includes('63-681'));
  assert.ok(top('staff annual training drills records', { jurisdiction: 'OK' }).includes('63-683.24I'));
  assert.ok(top('flood prone areas floodplain management', { jurisdiction: 'US' }).includes('44-CFR-60.3'));
});

test('a citation in the query ranks that section first', () => {
  assert.equal(lib.search('what does 63 O.S. § 683.24H say')[0].id, '63-683.24H');
  assert.equal(lib.search('explain 63-683.24J')[0].id, '63-683.24J');
  assert.equal(lib.search('44 CFR 60.3 permits')[0].id, '44-CFR-60.3');
});

test('jurisdiction filter', () => {
  assert.ok(lib.search('flood hazard', { jurisdiction: 'US' }).every((s) => s.jurisdiction === 'US'));
  assert.ok(lib.search('flood hazard', { jurisdiction: 'OK' }).every((s) => s.jurisdiction === 'OK'));
});

test('tokenizer keeps section numbers and matches word forms', () => {
  const same = (a, b) => assert.deepEqual(tokenize(a), tokenize(b), `${a} vs ${b}`);
  same('employees', 'employee'); same('appointment', 'appoint'); same('terminated', 'terminate'); same('termination', 'terminate'); same('policies', 'policy');
  assert.deepEqual(tokenize('Employees 825.110 hiring suspended'), ['employe', '825.110', 'hiring', 'suspend']);
});
