import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installShim, makeResponseStream } from '../scripts/lambda-shim.mjs';

installShim();
process.env.MODEL_MODE = 'mock';
process.env.LOCAL_DATA_DIR = mkdtempSync(join(tmpdir(), 'ranger-price-'));
delete process.env.TABLE_NAME; delete process.env.DATA_BUCKET; delete process.env.USER_POOL_ID;
const { handler } = await import('../src/handler.mjs');
const { priceKey, pickPrices, fetchPrices, refreshPrices } = await import('../src/pricing.mjs');

async function call(method, path, { body } = {}) {
  const stream = makeResponseStream();
  await handler({ rawPath: path, headers: {}, body: body ? JSON.stringify(body) : undefined, requestContext: { http: { method, sourceIp: '203.0.113.9' } } }, stream);
  await stream.done;
  const r = stream.result();
  return { ...r, json: JSON.parse(r.body) };
}

// Entries in the same shape as AWS's AmazonBedrockFoundationModels price list (us-east-1, Nov 2026).
let n = 0;
function offer(rows) {
  const products = {}, OnDemand = {};
  for (const [model, usagetype, inferenceType, usd, unit = '1M tokens', feature = 'On-demand Inference'] of rows) {
    const sku = `SKU${++n}`;
    products[sku] = { sku, attributes: { model, usagetype, inferenceType, feature, provider: 'OpenAI', regionCode: 'us-east-1' } };
    OnDemand[sku] = { [`${sku}.T`]: { priceDimensions: { [`${sku}.T.D`]: { unit, pricePerUnit: { USD: String(usd) } } } } };
  }
  return { products, terms: { OnDemand } };
}
const FM = offer([
  ['OpenAI GPT-5.6 Terra', 'USE1-MP:USE1_input_tokens_standard-Units', 'Input tokens', 2.2],
  ['OpenAI GPT-5.6 Terra', 'USE1-MP:USE1_output_tokens_standard-Units', 'Output tokens', 13.2],
  ['OpenAI GPT-5.6 Terra', 'USE1-MP:USE1_cache_read_tokens_standard-Units', 'Prompt cache read input tokens', 0.22],
  ['OpenAI GPT-5.6 Terra', 'USE1-MP:USE1_cache_write_tokens_30m_standard-Units', 'Prompt cache write input tokens', 2.75],
  ['OpenAI GPT-5.6 Terra', 'USE1-MP:USE1_input_tokens_long_ctx_standard-Units', 'Input tokens', 4.4],
  ['OpenAI GPT-5.6 Terra', 'USE1-MP:USE1_input_tokens_global_standard-Units', 'Input tokens', 2.0],
  ['OpenAI GPT-5.6 Terra', 'USE1-MP:USE1_output_tokens_global_standard-Units', 'Output tokens', 12.0],
  ['OpenAI GPT-5.6 Luna', 'USE1-MP:USE1_input_tokens_standard-Units', 'Input tokens', 0.22],
  ['OpenAI GPT-5.6 Luna', 'USE1-MP:USE1_output_tokens_standard-Units', 'Output tokens', 1.32]
]);
const FIRST_PARTY = offer([
  ['gpt-oss-120b', 'USE1-gpt-oss-120b-input-tokens', 'Input tokens', 0.00015, '1K tokens'],
  ['gpt-oss-120b', 'USE1-gpt-oss-120b-output-tokens', 'Output tokens', 0.0006, '1K tokens'],
  ['gpt-oss-120b', 'USE1-gpt-oss-120b-input-tokens-batch', 'Input tokens', 0.000075, '1K tokens', 'Batch Inference']
]);

test('model ids map to price-list names and tiers', () => {
  assert.deepEqual(priceKey('us.openai.gpt-5.6-terra'), { tier: 'standard', names: ['openaigpt56terra', 'gpt56terra'] });
  assert.equal(priceKey('global.openai.gpt-5.6-terra').tier, 'global');
  assert.equal(priceKey('anthropic.claude-x-v1:0').names[1], 'claudex');
  assert.equal(priceKey('nonsense'), null);
});

test('picks standard on-demand prices; ignores long-context, cache-write, batch and the other tier', () => {
  assert.deepEqual(pickPrices(FM, 'us.openai.gpt-5.6-terra'), { in: 2.2, out: 13.2, cacheRead: 0.22, model: 'OpenAI GPT-5.6 Terra', tier: 'standard' });
  assert.deepEqual(pickPrices(FM, 'global.openai.gpt-5.6-terra'), { in: 2, out: 12, cacheRead: null, model: 'OpenAI GPT-5.6 Terra', tier: 'global' });
  assert.equal(pickPrices(FM, 'us.openai.gpt-5.6-luna').out, 1.32);
  assert.equal(pickPrices(FM, 'us.openai.gpt-9-imaginary'), null);
  assert.deepEqual(pickPrices(FIRST_PARTY, 'openai.gpt-oss-120b-1:0'.replace('-1:0', '')), { in: 0.15, out: 0.6, cacheRead: null, model: 'gpt-oss-120b', tier: 'standard' }, '$ per 1K tokens converted to per 1M');
});

const fakeFetch = (lists) => async (url) => {
  const name = Object.keys(lists).find((k) => url.includes(`/${k}/`));
  return name ? new Response(JSON.stringify(lists[name])) : new Response('nope', { status: 404 });
};

test('fetchPrices looks in both AWS price lists', async () => {
  const both = fakeFetch({ AmazonBedrockFoundationModels: FM, AmazonBedrock: FIRST_PARTY });
  assert.equal((await fetchPrices('us.openai.gpt-5.6-terra', { fetchImpl: both })).list, 'AmazonBedrockFoundationModels');
  assert.equal((await fetchPrices('openai.gpt-oss-120b', { fetchImpl: both })).list, 'AmazonBedrock');
  assert.equal(await fetchPrices('us.openai.gpt-9-imaginary', { fetchImpl: both }), null);
  await assert.rejects(fetchPrices('us.openai.gpt-5.6-terra', { fetchImpl: async () => new Response('', { status: 503 }) }), /Couldn't read AWS's price list/);
});

test('refreshPrices saves prices, keeps old ones on failure, and respects manual mode', async () => {
  const ok = fakeFetch({ AmazonBedrockFoundationModels: FM });
  const r = await refreshPrices({ fetchImpl: ok });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  let s = (await call('GET', '/admin/settings')).json.settings;
  assert.equal(s.priceInputPerM, 2.2);
  assert.equal(s.priceOutputPerM, 13.2);
  assert.equal(s.priceCacheReadPerM, 0.22);
  assert.equal(s.priceCheck.model, 'OpenAI GPT-5.6 Terra');

  assert.equal((await refreshPrices({ fetchImpl: ok })).changed, false, 'same prices → not "changed"');

  const down = await refreshPrices({ fetchImpl: async () => new Response('', { status: 500 }) });
  assert.equal(down.ok, false);
  s = (await call('GET', '/admin/settings')).json.settings;
  assert.equal(s.priceInputPerM, 2.2, 'a failed check never wipes prices');
  assert.match(s.priceCheck.message, /Keeping the current prices/);

  // Typed prices are ignored while automatic prices are on…
  await call('PUT', '/admin/settings', { body: { priceInputPerM: 99 } });
  assert.equal((await call('GET', '/admin/settings')).json.settings.priceInputPerM, 2.2);
  // …and used once it's off; the daily check then leaves them alone.
  await call('PUT', '/admin/settings', { body: { autoPrices: false, priceInputPerM: 3, priceOutputPerM: 9 } });
  assert.equal((await refreshPrices({ fetchImpl: ok })).skipped, true);
  s = (await call('GET', '/admin/settings')).json.settings;
  assert.equal(s.priceInputPerM, 3);
  assert.equal(s.autoPrices, false);
});

test('the cost estimate uses the cached-input price', async () => {
  const { analytics } = await import('../src/analytics.mjs');
  const a = await analytics({ days: 30, prices: { in: 2.2, out: 13.2, cacheRead: 0.22 } });
  assert.equal(a.totals.estimatedCost, 0, 'no questions yet → $0');
});
