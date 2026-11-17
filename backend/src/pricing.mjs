// Keeps the Analytics cost estimate's token prices current, from AWS's public price list.
//
// AWS publishes Bedrock prices as JSON with no sign-in needed:
//   https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/<list>/current/<region>/index.json
// Third-party models (OpenAI GPT-5.6, GPT-6…) are in "AmazonBedrockFoundationModels";
// Amazon's own and open-weight models are in "AmazonBedrock". We look in both.
//
// A model id like "us.openai.gpt-5.6-terra" is matched to the price list's model name
// "OpenAI GPT-5.6 Terra". The prefix picks the pricing tier: "global." profiles use the
// global price, everything else (us., eu., apac. or none) the standard regional price.
// Long-context, batch, flex and priority prices are ignored: Ranger uses plain on-demand calls.
//
// Runs daily with the scheduled refresh, when an admin switches models, and from
// Settings → "Check now". Admins can turn it off and type prices in by hand.

import { getConfig, invalidateConfig } from './config.mjs';
import { kv } from './storage.mjs';

export const PRICE_LISTS = ['AmazonBedrockFoundationModels', 'AmazonBedrock'];
const listUrl = (list, region) => `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/${list}/current/${region}/index.json`;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** What to look for in the price list for a Bedrock model id. */
export function priceKey(modelId) {
  const id = String(modelId || '').trim();
  const m = id.match(/^(?:(us|eu|apac|jp|au|ca|global)\.)?([a-z0-9-]+)\.(.+)$/i);
  if (!m) return null;
  const provider = m[2];
  const name = m[3].replace(/-v\d+(?::\d+)?$/i, '');   // anthropic.claude-x-v1:0 → claude-x
  return {
    tier: (m[1] || '').toLowerCase() === 'global' ? 'global' : 'standard',
    names: [norm(provider + name), norm(name)]
  };
}

/**
 * Picks the on-demand input, output and cache-read prices for a model out of one price
 * list (the parsed index.json). Returns dollars per million tokens, or null if the model
 * isn't in this list.
 */
export function pickPrices(offer, modelId) {
  const key = priceKey(modelId);
  if (!key || !offer?.products) return null;
  const terms = offer.terms?.OnDemand || {};
  const found = {};
  let model = null;
  // Shortest usage type first, so "...-input-tokens" wins over longer variants with the same price.
  const products = Object.values(offer.products)
    .filter((p) => {
      const a = p.attributes || {};
      const n = norm(a.model);
      return n && (key.names.includes(n) || key.names.includes(norm((a.provider || '') + a.model)));
    })
    .sort((a, b) => String(a.attributes.usagetype).length - String(b.attributes.usagetype).length);

  for (const p of products) {
    const a = p.attributes;
    const u = String(a.usagetype || '').toLowerCase();
    const type = String(a.inferenceType || '').toLowerCase();
    if (/long_ctx|batch|flex|priority|cache_write|reserved|provisioned/.test(u + ' ' + type + ' ' + String(a.feature || '').toLowerCase())) continue;
    if (a.feature && !/on-demand/i.test(a.feature)) continue;
    if (key.tier === 'global' ? !/global/.test(u) : /global/.test(u)) continue;
    const kind = /cache_read|cached_input|cache read/.test(u + ' ' + type) ? 'cacheRead'
      : /input/.test(u + ' ' + type) ? 'in'
      : /output/.test(u + ' ' + type) ? 'out' : null;
    if (!kind || found[kind] != null) continue;
    const dim = Object.values(Object.values(terms[p.sku] || {})[0]?.priceDimensions || {})[0];
    const usd = Number(dim?.pricePerUnit?.USD);
    const unit = String(dim?.unit || '').toLowerCase();
    if (!Number.isFinite(usd)) continue;
    const perM = /1m/.test(unit) ? usd : /1k/.test(unit) ? usd * 1000 : null;
    if (perM == null) continue;
    found[kind] = Math.round(perM * 10000) / 10000;
    model = model || a.model;
  }
  if (found.in == null || found.out == null) return null;
  return { in: found.in, out: found.out, cacheRead: found.cacheRead ?? null, model, tier: key.tier };
}

/** Looks a model up in AWS's price lists. Returns prices with where they came from, or null. */
export async function fetchPrices(modelId, { region = process.env.AWS_REGION || 'us-east-1', fetchImpl = fetch } = {}) {
  const errors = [];
  for (const list of PRICE_LISTS) {
    try {
      const r = await fetchImpl(listUrl(list, region), { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) { errors.push(`${list}: HTTP ${r.status}`); continue; }
      const p = pickPrices(await r.json(), modelId);
      if (p) return { ...p, list, region };
    } catch (e) {
      errors.push(`${list}: ${e.message}`);
    }
  }
  if (errors.length === PRICE_LISTS.length) throw new Error(`Couldn't read AWS's price list (${errors.join('; ')}).`);
  return null;
}

/**
 * Updates the saved prices for the current model, unless an admin turned automatic
 * prices off. Never clears prices that were already there: if the lookup fails, the
 * old prices stay and the Settings page says why.
 */
export async function refreshPrices({ fetchImpl } = {}) {
  const settings = (await getConfig({ fresh: true })).settings;
  if (settings.autoPrices === false) return { skipped: true, reason: 'Automatic prices are turned off.' };
  const at = new Date().toISOString();
  let status, update = {};
  try {
    const p = await fetchPrices(settings.modelId, { fetchImpl });
    if (p) {
      update = { priceInputPerM: p.in, priceOutputPerM: p.out, priceCacheReadPerM: p.cacheRead ?? 0 };
      status = { ok: true, model: p.model, tier: p.tier, list: p.list, ...update };
    } else {
      status = { ok: false, message: `AWS's price list doesn't have ${settings.modelId} yet. Keeping the current prices.` };
    }
  } catch (e) {
    status = { ok: false, message: `${e.message} Keeping the current prices.` };
  }
  const changed = status.ok && (settings.priceInputPerM !== update.priceInputPerM || settings.priceOutputPerM !== update.priceOutputPerM || (settings.priceCacheReadPerM || 0) !== update.priceCacheReadPerM);
  const stored = await kv.get('CONFIG', 'settings');
  await kv.put({
    ...(stored || { pk: 'CONFIG', sk: 'settings' }),
    ...update,
    priceCheck: { at, modelId: settings.modelId, changed, ...status }
  });
  invalidateConfig();
  return { ...status, changed, at };
}
