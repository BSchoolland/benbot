import { DEBOUNCE_MS } from './config.mjs';
import { deliver } from './sessions.mjs';
import { q } from './db.mjs';

// One queue. Inputs for the same thread coalesce over DEBOUNCE_MS and are
// delivered in order; different threads never wait on each other.
const pending = new Map(); // threadKey -> { items: [], timer, chain: Promise }

export function enqueue(threadKey, item) {
  // item: { text, msgId?, preface?, mention? } — preface goes once before the batch; mention = the bot was @'d
  let p = pending.get(threadKey);
  if (!p) { p = { items: [], timer: null, chain: Promise.resolve() }; pending.set(threadKey, p); }
  p.items.push(item);
  clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    p.chain = p.chain.then(() => flush(threadKey)).catch((e) => console.error(`[${threadKey}] deliver failed:`, e.message));
  }, DEBOUNCE_MS);
}

async function flush(threadKey) {
  const p = pending.get(threadKey);
  if (!p || p.items.length === 0) return;
  const items = p.items.splice(0);
  const preface = items.find((i) => i.preface)?.preface;
  const text = [preface, ...items.map((i) => i.text)].filter(Boolean).join('\n');
  await deliver(threadKey, text, { mention: items.some((i) => i.mention) });
  const last = items.findLast((i) => i.msgId);
  if (last) q.setDelivered.run(last.msgId, threadKey);
}
