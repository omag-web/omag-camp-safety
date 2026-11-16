// Who gets Ranger's emails. Two lists, each an SNS topic whose email subscriptions are managed from
// the admin panel's Settings page:
//   messages → "Talk to OMAG" notes from members
//   alerts   → AWS alarm emails (Ranger is down, errors…) and worker failures (library rebuild,
//              answer check). Also gets "Talk to OMAG" notes while the messages list has
//              nobody confirmed on it, so a note is never sent to no one.

import { SNSClient, ListSubscriptionsByTopicCommand, SubscribeCommand, UnsubscribeCommand, PublishCommand } from '@aws-sdk/client-sns';

const TOPICS = {
  messages: () => process.env.MESSAGES_TOPIC_ARN,
  alerts: () => process.env.CONTACT_TOPIC_ARN
};
export const LISTS = Object.keys(TOPICS);
let sns;
const client = () => (sns ||= new SNSClient({}));
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const local = { messages: new Map(), alerts: new Map() };   // when there's no topic (tests, npm run dev)

const topicOf = (list) => {
  if (!TOPICS[list]) throw bad('Unknown list.');
  return TOPICS[list]();
};

/** Everyone on a list. pending = they haven't clicked AWS's confirmation link yet. */
export async function listRecipients(list = 'alerts') {
  const topic = topicOf(list);
  if (!topic) return [...local[list].entries()].map(([email, s]) => ({ email, ...s })).sort((a, b) => a.email.localeCompare(b.email));
  const out = [];
  let NextToken;
  do {
    const r = await client().send(new ListSubscriptionsByTopicCommand({ TopicArn: topic, NextToken }));
    for (const s of r.Subscriptions || []) {
      if (s.Protocol !== 'email' && s.Protocol !== 'email-json') continue;
      const pending = !s.SubscriptionArn || s.SubscriptionArn === 'PendingConfirmation';
      out.push({ email: s.Endpoint, pending, id: pending ? null : s.SubscriptionArn.split(':').pop() });
    }
    NextToken = r.NextToken;
  } while (NextToken);
  return out.sort((a, b) => a.email.localeCompare(b.email));
}

export async function addRecipient(list, email) {
  const topic = topicOf(list);
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw bad('Enter an email address.');
  const cur = await listRecipients(list);
  if (cur.some((r) => r.email.toLowerCase() === email)) throw bad(`${email} is already on this list.`);
  if (!topic) { local[list].set(email, { pending: true, id: null }); return { message: `Added ${email}.` }; }
  await client().send(new SubscribeCommand({ TopicArn: topic, Protocol: 'email', Endpoint: email }));
  return { message: `AWS sent ${email} a confirmation email. Emails start once they click "Confirm subscription" in it (check Junk).` };
}

export async function removeRecipient(list, id) {
  const topic = topicOf(list);
  if (!/^[0-9a-f-]{20,64}$/i.test(String(id || ''))) throw bad('Unknown recipient.');
  const cur = await listRecipients(list);
  const r = cur.find((x) => x.id === id);
  if (!r) throw bad('That recipient isn’t on the list any more.', 404);
  if (list === 'alerts' && cur.filter((x) => !x.pending).length <= 1) throw bad('Keep at least one confirmed address, or nobody gets Ranger’s alarm emails.');
  if (!topic) { local[list].delete(r.email); return { message: `Removed ${r.email}.` }; }
  await client().send(new UnsubscribeCommand({ SubscriptionArn: `${topic}:${id}` }));
  return { message: `Removed ${r.email}.` };
}

/** Sends an email to everyone on a list. Never throws. Returns the list it went to. */
export async function notify(subject, message, list = 'alerts') {
  let topic = topicOf(list);
  // A member's note goes to the alerts list until someone has confirmed on the messages list.
  if (list === 'messages') {
    const confirmed = (await listRecipients('messages').catch(() => [])).filter((r) => !r.pending).length;
    if (!confirmed) { list = 'alerts'; topic = topicOf('alerts'); }
  }
  if (!topic) { console.log(`notify ${list} (no topic):`, subject); return list; }
  try {
    await client().send(new PublishCommand({ TopicArn: topic, Subject: subject.slice(0, 99), Message: message }));
  } catch (e) { console.error('notify failed', e); }
  return list;
}

export const _localSet = (list, email, s) => local[list].set(email, s);
