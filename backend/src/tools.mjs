// Ranger's tools: search the library and read sections, plus writing documents (see drafts.mjs).

import { validateDraft, resolveCitations } from './drafts.mjs';

export const TOOL_SPECS = [
  {
    toolSpec: {
      name: 'search_law',
      description: 'Search the library: the Oklahoma camp safety law and related Oklahoma statutes (emergency management, campgrounds, floodplains, tort claims), any federal regulations OMAG adds, and OMAG guidance documents and web pages. Returns matching sections with id, citation, heading and a short excerpt. Use get_sections to read full text before citing.',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Keywords a statute would use, or a citation like "63 O.S. § 683.24E".' },
            jurisdiction: { type: 'string', enum: ['OK', 'US', 'OMAG', 'any'], description: 'OK = Oklahoma statutes, US = federal regulations, OMAG = OMAG and agency guidance documents and web pages, any = all (default).' }
          },
          required: ['query']
        }
      }
    }
  },
  {
    toolSpec: {
      name: 'get_sections',
      description: 'Read the full text of up to 6 sections by library id (e.g. "63-683.24E", "63-681").',
      inputSchema: {
        json: {
          type: 'object',
          properties: { ids: { type: 'array', items: { type: 'string' }, maxItems: 6 } },
          required: ['ids']
        }
      }
    }
  }
];

const MAX_SECTION_CHARS = 9000;

/**
 * Runs a tool call. Returns { result, status, ids } where ids are sections the model has now seen
 * (a Promise for get_sample, which reads a file).
 * ctx: { templates, seen, drafts, loadSample }
 */
export function runTool(name, input, library, ctx = {}) {
  if (name === 'write_document') {
    let draft;
    try { draft = validateDraft(input); } catch (e) {
      return { status: 'Writing your document', ids: [], result: { error: `${e.message} Send the complete document again.` } };
    }
    const r = resolveCitations(draft, library, ctx.seen || new Set());
    ctx.drafts?.push(r.draft);
    return {
      status: `Finishing ${r.draft.title}`, ids: [],
      result: {
        shown: true, title: r.draft.title,
        ...(r.dropped.length ? { removed_citations: r.dropped, note: 'These citations were removed because you had not read those sections with get_sections. That is fine if the document reads well without them.' } : {}),
        message: 'The member now sees the document below your answer, with Preview and Download Word buttons. In a few sentences, say what you tailored to their camp, list every [bracketed] item they still need to fill in or decide, and remind them to review it with their municipal attorney, county emergency management or OMAG before they use it. Don’t repeat the document text. Offer to make changes.'
      }
    };
  }
  // Not offered yet (see drafts.mjs): reads an OMAG sample as a guide.
  if (name === 'get_sample') {
    const t = (ctx.templates || []).find((x) => x.id === String(input?.template_id || ''));
    if (!t || !ctx.loadSample) return { status: 'Looking for an OMAG sample', ids: [], result: { error: 'No sample with that id. Use an id from the list, or write the document without one.' } };
    return ctx.loadSample(t.id).then(
      (s) => ({ status: `Reading OMAG’s sample ${s.title}`, ids: [], result: { title: s.title, text: s.text, ...(s.truncated ? { truncated: true } : {}), how_to_use: 'This is a guide to what the document should cover. Write the member’s document fresh, in your own words, for their camp; don’t copy it with blanks filled in.' } }),
      (e) => ({ status: 'Looking for an OMAG sample', ids: [], result: { error: e.message || 'The sample couldn’t be read. Write the document without it.' } })
    );
  }
  if (name === 'search_law') {
    const q = String(input?.query || '').slice(0, 300);
    const j = ['OK', 'US', 'OMAG'].includes(input?.jurisdiction) ? input.jurisdiction : undefined;
    const hits = library.search(q, { jurisdiction: j, limit: 8 });
    return {
      status: `Searching ${j === 'US' ? 'federal regulations' : j === 'OK' ? 'Oklahoma statutes' : j === 'OMAG' ? 'OMAG guidance' : 'the library'} for “${q}”`,
      ids: [],
      result: hits.length
        ? { results: hits.map((s) => ({ id: s.id, cite: s.cite, heading: s.heading, excerpt: s.text.slice(0, 280).replace(/\s+/g, ' ') + (s.text.length > 280 ? '…' : '') })) }
        : { results: [], message: 'No matching sections. Try different words or a citation.' }
    };
  }
  if (name === 'get_sections') {
    const ids = (Array.isArray(input?.ids) ? input.ids : []).slice(0, 6);
    const found = [];
    const missing = [];
    for (const raw of ids) {
      const s = library.get(raw);
      if (s) found.push(s); else missing.push(String(raw));
    }
    return {
      status: found.length ? `Reading ${found.map((s) => s.cite).join(', ')}` : 'Looking up sections',
      ids: found.map((s) => s.id),
      result: {
        sections: found.map((s) => ({
          id: s.id, cite: s.cite, heading: s.heading, source: s.source,
          text: s.text.length > MAX_SECTION_CHARS ? s.text.slice(0, MAX_SECTION_CHARS) + '\n[…truncated]' : s.text
        })),
        ...(missing.length ? { not_found: missing } : {})
      }
    };
  }
  return { status: 'Working', ids: [], result: { error: `Unknown tool ${name}` } };
}
