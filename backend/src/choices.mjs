// Multiple-choice questions. Ranger asks one question at a time; when a question has a short list of
// likely answers it calls ask_choice and the member page shows a pop-up with answer buttons. The turn
// ends there, and the member's pick comes back as their next message.

const MAX_OPTIONS = 12;

export const ASK_CHOICE_SPEC = {
  toolSpec: {
    name: 'ask_choice',
    description: 'Ask the member ONE question with answer buttons in a pop-up, then stop and wait. Use it whenever your question has a short list of likely answers: yes or no, day or overnight, which program type, which hazards apply, a select-all-that-apply checklist. The member’s choice comes back as their next message. Calling this ends your reply, so research and write anything else first.',
    inputSchema: {
      json: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The one question, in plain language, e.g. "Is this a day camp or an overnight camp?"' },
          options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: MAX_OPTIONS, description: 'The answers to show as buttons, a few words each. Include "Not sure" when the member might not know.' },
          multiple: { type: 'boolean', description: 'true when the member may pick more than one (select all that apply). Default false.' },
          exclusive: { type: 'array', items: { type: 'string' }, description: 'Options that can’t be combined with others when multiple is true, e.g. ["None", "Not sure"].' },
          other: { type: 'boolean', description: 'Also show a box to type a different answer. Default true.' }
        },
        required: ['question', 'options']
      }
    }
  }
};

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Checks and tidies a choice question from the model or the browser. Throws on anything unusable. */
export function validateChoice(input) {
  const question = str(input?.question, 400);
  if (!question) throw new Error('ask_choice needs a question.');
  const seen = new Set();
  const options = (Array.isArray(input?.options) ? input.options : [])
    .map((o) => str(typeof o === 'object' && o ? o.label : o, 120))
    .filter((o) => o && !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()))
    .slice(0, MAX_OPTIONS);
  if (options.length < 2) throw new Error('ask_choice needs at least two different options.');
  const multiple = input?.multiple === true;
  const exclusive = multiple && Array.isArray(input?.exclusive)
    ? options.filter((o) => input.exclusive.some((x) => str(x, 120).toLowerCase() === o.toLowerCase()))
    : [];
  return { question, options, multiple, ...(exclusive.length ? { exclusive } : {}), other: input?.other !== false };
}

/** How a choice question reads back to the model in conversation history. */
export function choiceText(choice) {
  try {
    const c = validateChoice(choice);
    return `[Answer buttons shown to the member${c.multiple ? ' (more than one allowed)' : ''}: ${c.options.join(' | ')}${c.other ? ' | or type another answer' : ''}]`;
  } catch { return ''; }
}
