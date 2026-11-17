// Questions Ranger asks the member, one at a time (the ask_member tool).
// The member page shows each one as a small pop-up card: pick one, pick several,
// or type a short answer. The turn ends when Ranger asks, so it waits for the answer.

export const QUESTION_KINDS = ['choice', 'multi', 'text'];
const MAX_OPTIONS = 8;

export const ASK_MEMBER_SPEC = {
  toolSpec: {
    name: 'ask_member',
    description: 'Ask the member ONE question and wait for their answer. The member sees it as a card: "choice" = pick one option, "multi" = pick any that apply, "text" = type a short answer (a number, a name, a date). Use it for every question you ask. Your turn ends when you call it, so call it last and by itself.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'One short, plain question.' },
          kind: { type: 'string', enum: QUESTION_KINDS },
          options: { type: 'array', items: { type: 'string' }, description: 'For choice and multi: 2 to 8 short answers, the most common first. Leave out "Other"; the member can always type their own answer.' },
          allow_other: { type: 'boolean', description: 'For choice and multi: let the member type an answer that isn’t listed (default true).' },
          hint: { type: 'string', description: 'Optional: one short line under the question, e.g. why it matters or an example.' },
          placeholder: { type: 'string', description: 'For text: example answer shown in the box, e.g. "e.g. 24".' }
        },
        required: ['question', 'kind']
      }
    }
  }
};

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Checks and tidies a question from the model (or from the browser's history). Throws on anything unusable. */
export function validateQuestion(input) {
  if (!input || typeof input !== 'object') throw new Error('The question is empty.');
  const question = str(input.question, 300);
  if (!question) throw new Error('Write the question.');
  let kind = QUESTION_KINDS.includes(input.kind) ? input.kind : 'choice';
  const options = [...new Set((Array.isArray(input.options) ? input.options : []).map((o) => str(o, 120)).filter((o) => o && !/^(other|something else)\b/i.test(o)))].slice(0, MAX_OPTIONS);
  if (kind !== 'text' && options.length < 2) {
    if (options.length) throw new Error('Give at least two options, or use kind "text".');
    kind = 'text';
  }
  const q = { question, kind };
  if (kind !== 'text') { q.options = options; q.allowOther = input.allow_other !== false && input.allowOther !== false; }
  const hint = str(input.hint, 200); if (hint) q.hint = hint;
  const placeholder = str(input.placeholder, 80); if (kind === 'text' && placeholder) q.placeholder = placeholder;
  return q;
}

/** How a question Ranger asked earlier reads in the conversation history the model sees. */
export function questionText(q) {
  const opts = q.options?.length ? ` Options: ${q.options.join('; ')}${q.allowOther ? '; or their own answer' : ''}.` : '';
  return `[You asked the member: "${q.question}"${q.kind === 'multi' ? ' (pick any that apply)' : ''}${opts}]`;
}
