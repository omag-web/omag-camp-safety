// Files members attach to a question (a handbook, an ordinance, a draft policy).
// The file is read once, here, and only its text goes back to the browser, which sends it
// along with the conversation. Ranger never stores the file or its text; the conversation log
// keeps just the file name.

import { extractDoc } from './docs.mjs';
import { redact } from './privacy.mjs';

export const MAX_FILE_BYTES = 4 * 1024 * 1024;   // the API accepts about 6 MB per request, base64 included
export const MAX_DOC_CHARS = 80_000;              // about 20,000 words: a typical personnel handbook
export const MAX_TOTAL_CHARS = 160_000;           // across all files in one conversation
const KINDS = { pdf: 'pdf', docx: 'docx', txt: 'txt', md: 'md' };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const cleanName = (n) => String(n || 'document').replace(/[\r\n<>"]/g, ' ').trim().slice(0, 120) || 'document';

/** Reads an uploaded file. Returns { name, text, chars, truncated, removed } or throws a readable 400. */
export async function readAttachment({ name, data }) {
  name = cleanName(name);
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const kind = KINDS[ext];
  if (ext === 'doc') throw bad('Ranger can read Word files saved as .docx, not the older .doc format. In Word, choose File → Save As → Word Document (.docx).');
  if (!kind) throw bad('Ranger can read PDF, Word (.docx) and text files.');
  if (typeof data !== 'string' || !data) throw bad('The file didn’t arrive. Try attaching it again.');
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw bad('That file is empty.');
  if (buf.length > MAX_FILE_BYTES) throw bad('That file is over 4 MB. Attach just the sections you need, or save it as a smaller PDF.');

  let text;
  try {
    ({ text } = await extractDoc(buf, kind));
  } catch (e) {
    console.error('attachment read failed', e);
    throw bad('Ranger couldn’t read that file. If it’s password-protected, remove the password; otherwise try saving it as PDF or Word again.');
  }
  text = String(text || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.replace(/\s/g, '').length < 40) {
    throw bad(kind === 'pdf'
      ? 'This PDF looks like a scanned image, so there’s no text for Ranger to read. Attach the Word version, or a PDF with searchable text.'
      : 'Ranger didn’t find any text in that file.');
  }
  const r = redact(text);   // Social Security, card, account and license numbers and birth dates never reach the model
  const truncated = r.text.length > MAX_DOC_CHARS;
  return { name, text: r.text.slice(0, MAX_DOC_CHARS), chars: r.text.length, truncated, removed: [...new Set(r.removed)] };
}

/**
 * Checks the attachments a chat request carries (the browser keeps them with the conversation):
 * at most 3 per message, each trimmed and redacted again, and no more than MAX_TOTAL_CHARS in all,
 * keeping the newest when there's too much. A file whose text the browser no longer has keeps
 * just its name, so Ranger can ask for it again.
 */
export function cleanAttachments(messages) {
  let budget = MAX_TOTAL_CHARS;
  const out = messages.map((m) => ({ ...m, attachments: undefined }));
  for (let i = messages.length - 1; i >= 0; i--) {
    const list = Array.isArray(messages[i]?.attachments) ? messages[i].attachments.slice(0, 3) : [];
    if (!list.length || messages[i].role !== 'user') continue;
    out[i].attachments = list.map((a) => {
      const text = redact(String(a?.text || '').slice(0, MAX_DOC_CHARS)).text;
      const keep = text.length <= budget ? text : '';
      budget -= keep.length;
      return { name: cleanName(a?.name), text: keep };
    });
  }
  return out;
}

/** How an attachment is shown to the model: clearly marked as the member's document, not instructions. */
export function attachmentBlock(a) {
  const name = cleanName(a.name);
  return a.text
    ? `<member_document name="${name}">\n${a.text}\n</member_document>`
    : `<member_document name="${name}">[The member attached this earlier, but its text isn't available any more. If you need it, ask them to attach it again.]</member_document>`;
}
