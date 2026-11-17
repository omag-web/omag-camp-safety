// OMAG's sample documents: plain Word files Ranger reads as a guide when it writes a
// document of that kind (the get_sample tool in tools.mjs). Ranger never copies a
// sample or fills it in; it writes each member's document from scratch.
//
//   pk SAMPLE  sk <id>  { id, title, description, enabled, order, files{}, updatedAt, updatedBy }
//     files: { all | camp | facility | campground | unsure: { key, filename, size, chars, uploadedAt, uploadedBy } }
//     A member gets the file for their program type, else the "all" file.
//   S3:  samples/<id>/<version>-<stamp>.docx
//
// The description matters: it's how Ranger picks the right sample for a request.

import { randomBytes } from 'node:crypto';
import { kv, blobs } from './storage.mjs';

const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
export const VERSIONS = ['all', 'camp', 'facility', 'campground', 'unsure'];
export const VERSION_LABEL = { all: 'Every program type', camp: 'Youth camp or outdoor program', facility: 'Camp facility', campground: 'Recreational campground', unsure: 'Not sure yet / several' };
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const SAMPLE_CHARS = 30_000;

const slug = (s) => String(s || 'sample').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'sample';
const strip = ({ pk, sk, ...t }) => t;

/** The text of a Word file, tidied. */
export async function docxText(buf) {
  const { value } = await (await import('mammoth')).default.extractRawText({ buffer: buf });
  return String(value || '').replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function listSamples() {
  const all = await kv.query('SAMPLE');
  return all.map(strip).sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.title.localeCompare(b.title));
}
export async function getSample(id) {
  const t = await kv.get('SAMPLE', String(id || ''));
  if (!t) throw err('Sample not found.', 404);
  return strip(t);
}

export async function createSample({ title, description }, by) {
  title = String(title || '').trim().slice(0, 120);
  if (!title) throw err('Give the sample a title.');
  const id = `${slug(title)}-${randomBytes(2).toString('hex')}`;
  const t = { id, title, description: String(description || '').trim().slice(0, 400), enabled: false, order: 99, files: {}, updatedAt: new Date().toISOString(), updatedBy: by };
  await kv.put({ pk: 'SAMPLE', sk: id, ...t });
  return t;
}

export async function updateSample(id, input, by) {
  const t = await getSample(id);
  const next = { ...t };
  if ('title' in input) { next.title = String(input.title || '').trim().slice(0, 120); if (!next.title) throw err('Give the sample a title.'); }
  if ('description' in input) next.description = String(input.description || '').trim().slice(0, 400);
  if ('order' in input) next.order = Math.max(0, Math.min(99, Number(input.order) || 0));
  if ('enabled' in input) {
    next.enabled = !!input.enabled;
    if (next.enabled && !Object.keys(next.files).length) throw err('Upload a Word file before turning the sample on.');
  }
  next.updatedAt = new Date().toISOString(); next.updatedBy = by;
  await kv.put({ pk: 'SAMPLE', sk: id, ...next });
  return next;
}

export async function deleteSample(id) {
  const t = await getSample(id);
  await Promise.all(Object.values(t.files).map((f) => blobs.del(f.key)));
  await kv.del('SAMPLE', id);
}

/** Step 1 of uploading a Word file: returns a URL to PUT the file to. */
export async function fileUploadUrl(id, { version, filename, size }) {
  await getSample(id);
  if (!VERSIONS.includes(version)) throw err('Choose which program type this file is for.');
  if (!/\.docx$/i.test(String(filename || ''))) throw err(/\.doc$/i.test(String(filename || '')) ? 'Save it as a .docx first (in Word: File → Save As → Word Document).' : 'Upload a Word (.docx) file.');
  if (!(size > 0) || size > 10 * 1024 * 1024) throw err('Word files must be under 10 MB.');
  const key = `samples/${id}/${version}-${Date.now()}.docx`;
  return { key, uploadUrl: await blobs.uploadUrl(key, DOCX), contentType: DOCX };
}

/** Step 2: checks the uploaded file has readable text and attaches it. */
export async function attachFile(id, { version, key, filename }, by) {
  const t = await getSample(id);
  if (!VERSIONS.includes(version) || !String(key || '').startsWith(`samples/${id}/`)) throw err('Upload not found.', 404);
  const buf = await blobs.get(key);
  if (!buf) throw err('The upload didn’t arrive. Try again.', 404);
  let text;
  try { text = await docxText(buf); } catch { await blobs.del(key); throw err('That file couldn’t be read. Open it in Word, save it as a .docx and try again.'); }
  if (text.length < 50) { await blobs.del(key); throw err('That file has almost no text. Upload the full sample document.'); }
  const old = t.files[version];
  t.files[version] = { key, filename: String(filename || 'sample.docx').slice(0, 200), size: buf.length, chars: text.length, uploadedAt: new Date().toISOString(), uploadedBy: by };
  if (old && old.key !== key) await blobs.del(old.key);
  t.updatedAt = new Date().toISOString(); t.updatedBy = by;
  await kv.put({ pk: 'SAMPLE', sk: id, ...t });
  return { sample: t, chars: text.length, truncated: text.length > SAMPLE_CHARS };
}

export async function removeFile(id, version) {
  const t = await getSample(id);
  const f = t.files[version];
  if (!f) throw err('That file isn’t attached.', 404);
  await blobs.del(f.key);
  delete t.files[version];
  if (!Object.keys(t.files).length) t.enabled = false;
  await kv.put({ pk: 'SAMPLE', sk: id, ...t });
  return t;
}

/** Which file a member with this program type gets: the file for that type, else the "all" file. */
export function pickFile(t, form) {
  if (t.files[form]) return t.files[form];
  return t.files.all || null;
}

/** Samples Ranger can read for this program type: switched on, with a file for it. */
export async function samplesFor(form) {
  return (await listSamples())
    .filter((t) => t.enabled && pickFile(t, form))
    .map((t) => ({ id: t.id, title: t.title, description: t.description }));
}

/** A sample's text for Ranger (get_sample). */
export async function readSample(id, form) {
  const t = await getSample(id);
  if (!t.enabled) throw err('That sample isn’t available.');
  const f = pickFile(t, form);
  if (!f) throw err('That sample isn’t available for this program type.');
  const buf = await blobs.get(f.key);
  if (!buf) throw err('The sample file is missing.');
  let text = await docxText(buf);
  const truncated = text.length > SAMPLE_CHARS;
  if (truncated) text = text.slice(0, SAMPLE_CHARS);
  return { title: t.title, text, truncated };
}
