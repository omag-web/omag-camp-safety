// Custom documents: Ranger writes a plan, policy, procedure, form, letter or checklist
// for the member's own camp (write_document). The draft is plain structured JSON that
// the member page previews and that the server turns into a Word file on request
// (POST /documents/docx).
//
// OMAG's sample documents (admin panel → Sample documents, samples.mjs) are offered to
// the model through get_sample, as a guide to what a document should cover, never as a
// form to fill in. The tool only appears when at least one sample is switched on.

import { Document, Packer, Paragraph, TextRun, HeadingLevel, Footer, PageNumber, AlignmentType, LevelFormat, BorderStyle } from 'docx';

export const BLOCK_TYPES = ['heading', 'paragraph', 'bullets', 'numbered', 'signature'];
const MAX_BLOCKS = 400;
const MAX_TEXT = 5000;
const MAX_ITEMS = 60;
const MAX_TOTAL = 150_000;
const SAMPLE_CHARS = 30_000;

export const WRITE_DOCUMENT_SPEC = {
  toolSpec: {
    name: 'write_document',
    description: 'Write a complete, custom document (emergency action plan, hazard assessment, weather or water safety plan, policy, procedure, form, parent letter, notice, checklist) for this member’s camp. The member sees a preview and can download it as a Word file. Always send the whole document, including when revising one.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Document title, e.g. "Severe Weather and Lightning Plan".' },
          subtitle: { type: 'string', description: 'Optional line under the title, usually the camp and municipality, e.g. "Camp Wintersmith, City of Ada, Oklahoma".' },
          blocks: {
            type: 'array',
            description: 'The document, in order. Use **double asterisks** for bold. Cite statutes inside the text with [[library id]] markers.',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: BLOCK_TYPES },
                level: { type: 'integer', minimum: 1, maximum: 3, description: 'Heading level (1 = section, 2 = subsection, 3 = minor).' },
                text: { type: 'string', description: 'For heading and paragraph.' },
                items: { type: 'array', items: { type: 'string' }, description: 'For bullets, numbered and signature (one signature line per item, e.g. "Camp Director", "Parks and Recreation Director").' }
              },
              required: ['type']
            }
          }
        },
        required: ['title', 'blocks']
      }
    }
  }
};

/** Offered when OMAG has sample documents switched on (see samples.mjs). */
export const GET_SAMPLE_SPEC = {
  toolSpec: {
    name: 'get_sample',
    description: 'Read the text of one of OMAG’s sample documents, as a guide to what such a document usually covers. Use it as a reference, not a form to fill in.',
    inputSchema: { json: { type: 'object', properties: { sample_id: { type: 'string', description: 'A sample id from the list in your instructions.' } }, required: ['sample_id'] } }
  }
};

const str = (v, max) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '');

/** Checks and tidies a draft from the model or the browser. Throws on anything unusable. */
export function validateDraft(input) {
  if (!input || typeof input !== 'object') throw new Error('The document is empty.');
  const title = str(input.title, 200);
  if (!title) throw new Error('The document needs a title.');
  const subtitle = str(input.subtitle, 200);
  const blocks = [];
  let total = title.length + subtitle.length;
  for (const b of (Array.isArray(input.blocks) ? input.blocks : []).slice(0, MAX_BLOCKS)) {
    if (!b || !BLOCK_TYPES.includes(b.type)) continue;
    let out;
    if (b.type === 'heading' || b.type === 'paragraph') {
      const text = str(b.text, MAX_TEXT);
      if (!text) continue;
      out = b.type === 'heading' ? { type: 'heading', level: [1, 2, 3].includes(Number(b.level)) ? Number(b.level) : 1, text } : { type: 'paragraph', text };
      total += text.length;
    } else {
      const items = (Array.isArray(b.items) ? b.items : []).map((x) => str(x, MAX_TEXT)).filter(Boolean).slice(0, MAX_ITEMS);
      if (!items.length) continue;
      out = { type: b.type, items };
      total += items.join('').length;
    }
    if (total > MAX_TOTAL) throw new Error('The document is too long.');
    blocks.push(out);
  }
  if (!blocks.length) throw new Error('The document has no content.');
  return { title, ...(subtitle ? { subtitle } : {}), blocks };
}

/**
 * Turns [[id]] markers into formal citations for sections the model read with get_sections
 * this conversation. Unverified markers are dropped. Returns { draft, cited, dropped }.
 */
export function resolveCitations(draft, library, seen) {
  const cited = new Set();
  const dropped = new Set();
  const fix = (t) => t.replace(/\s*\[\[([^\]\n]{1,40})\]\]/g, (_, raw) => {
    const s = library.get(raw.trim());
    if (s && seen.has(s.id)) { cited.add(s.id); return ` (${s.cite})`; }
    dropped.add(raw.trim());
    return '';
  });
  const blocks = draft.blocks.map((b) => (b.items ? { ...b, items: b.items.map(fix) } : { ...b, text: fix(b.text) }));
  return { draft: { ...draft, blocks }, cited: [...cited], dropped: [...dropped] };
}

/** Plain-text version, given back to the model when the member asks for changes. */
export function draftToText(d) {
  const lines = [`# ${d.title}`];
  if (d.subtitle) lines.push(d.subtitle);
  for (const b of d.blocks) {
    if (b.type === 'heading') lines.push('', `${'#'.repeat(b.level + 1)} ${b.text}`);
    else if (b.type === 'paragraph') lines.push('', b.text);
    else if (b.type === 'bullets') lines.push('', ...b.items.map((x) => `- ${x}`));
    else if (b.type === 'numbered') lines.push('', ...b.items.map((x, i) => `${i + 1}. ${x}`));
    else lines.push('', ...b.items.map((x) => `____________________  ${x}`));
  }
  return lines.join('\n');
}

/** The model-facing block for the draft the member is looking at. */
export function currentDraftBlock(d) {
  return `<current_draft>\nThe member is looking at this document you wrote earlier. If they ask for changes, call write_document again with the complete revised document.\n\n${draftToText(d).slice(0, 60_000)}\n</current_draft>`;
}

export function draftFilename(d, municipality) {
  const who = String(municipality || '').replace(/[^\w .,'&-]+/g, '').trim().slice(0, 60);
  const base = who && !d.title.toLowerCase().includes(who.toLowerCase()) ? `${d.title} - ${who}` : d.title;
  return `${base}.docx`.replace(/[\\/:*?"<>|]+/g, '-');
}

/* ---------- Word file ---------- */

const FONT = 'Calibri';
const FOREST = '1E3A2F';   // Ranger's forest green

/** **bold** spans → TextRuns. */
function runs(text, opts = {}) {
  return String(text).split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((part) => {
    const bold = /^\*\*[^*]+\*\*$/.test(part);
    return new TextRun({ text: bold ? part.slice(2, -2) : part.replace(/\*\*/g, ''), bold: bold || opts.bold, font: FONT, size: opts.size, color: opts.color });
  });
}

/** Builds the .docx. Returns a Buffer. */
export async function draftToDocx(d, { today = new Date() } = {}) {
  const children = [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: d.subtitle ? 60 : 280 }, children: runs(d.title, { bold: true, size: 32, color: FOREST }) })
  ];
  if (d.subtitle) children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 280 }, children: runs(d.subtitle, { size: 24, color: '595959' }) }));
  let list = 0;
  for (const b of d.blocks) {
    if (b.type === 'heading') {
      const heading = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][b.level - 1];
      children.push(new Paragraph({ heading, spacing: { before: b.level === 1 ? 280 : 200, after: 100 }, keepNext: true, children: runs(b.text, { bold: true, size: [28, 24, 22][b.level - 1], color: FOREST }) }));
    } else if (b.type === 'paragraph') {
      children.push(new Paragraph({ spacing: { after: 140 }, children: runs(b.text) }));
    } else if (b.type === 'bullets') {
      for (const it of b.items) children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: runs(it) }));
      children.push(new Paragraph({ spacing: { after: 60 }, children: [] }));
    } else if (b.type === 'numbered') {
      list += 1;   // each list restarts at 1
      for (const it of b.items) children.push(new Paragraph({ numbering: { reference: 'num', level: 0, instance: list }, spacing: { after: 60 }, children: runs(it) }));
      children.push(new Paragraph({ spacing: { after: 60 }, children: [] }));
    } else {
      for (const it of b.items) {
        children.push(new Paragraph({ spacing: { before: 480 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } }, indent: { right: 4320 }, children: [] }));
        children.push(new Paragraph({ spacing: { after: 60 }, children: runs(it, { size: 20 }) }));
        children.push(new Paragraph({ spacing: { before: 200 }, children: runs('Date: ____________________', { size: 20 }) }));
      }
    }
  }
  const date = today.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Chicago' });
  const doc = new Document({
    creator: 'Ranger (OMAG)',
    title: d.title,
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    numbering: { config: [{ reference: 'num', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }] },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },   // US Letter, 1-inch margins
      footers: {
        default: new Footer({ children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `DRAFT prepared with Ranger, OMAG’s AI assistant, on ${date}. Review with your municipal attorney or OMAG before use.`, size: 16, color: '7F7F7F', font: FONT })] }),
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 16, color: '7F7F7F', font: FONT })] })
        ] })
      },
      children
    }]
  });
  return Packer.toBuffer(doc);
}
