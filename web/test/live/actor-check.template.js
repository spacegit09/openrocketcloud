setTimeout(() => { console.log('timed out'); Deno.exit(1); }, 180000);
// Run with: cat test/live/actor-check.js | base44 exec   (MODEL is prepended by make-script.mjs)
const log = (...a) => console.log(...a);
const me = await base44.auth.me();
const email = me.email.toLowerCase();
log('signed in as', email);
let ok = true;
const check = (cond, what) => { log(cond ? 'PASS' : 'FAIL', what); if (!cond) ok = false; };

const call = async (fn, body) => (await base44.functions.invoke(fn, body)).data;
const d = await call('designs', { action: 'create', name: 'Live check (delete me)' });
check(Boolean(d?.id) && d.owner_email === email, 'create a design through the designs function');
check((await call('designs', { action: 'list' })).some((x) => x.id === d.id), 'it is listed for its owner');
let denied = false;
try {
  await base44.entities.Design.create({ room: crypto.randomUUID(), people: [], sealed: 'x' });
} catch {
  denied = true;
}
check(denied, 'the Design table refuses direct writes');
const motor = await call('motors', { action: 'add', filename: 'live-check.eng', content: 'X42 29 124 0 0.05 0.1 LiveCheck\n0.1 50\n0.2 0\n', summary: '[]' });
check(Boolean(motor?.id), 'add a motor through the motors function');
const plan = await call('flights', { action: 'create', name: 'Live check plan (delete me)', design_id: d.id, design_name: d.name, launch_time: new Date().toISOString(), summary: 'live check', data: 'H4sIAAAAAAAAA6uuBQBDv6ajAgAAAA==' });
check(plan?.name === 'Live check plan (delete me)', 'save a launch plan through the flights function');
check((await call('flights', { action: 'get', id: plan.id })).data === 'H4sIAAAAAAAAA6uuBQBDv6ajAgAAAA==', 'it opens again as saved');
let unread = false;
try {
  unread = (await base44.entities.SavedFlight.list('-created_date', 50)).every((r) => !r.sealed);
} catch {
  unread = true;
}
check(unread, 'sealed launch plans are not readable from the table directly');

// A direct WebSocket (the exec environment does not always hand the sign-in to the SDK's actor
// connections): token from the authenticated mint endpoint, then the socket it names.
const appId = JSON.parse((await Deno.readTextFile('base44/.app.jsonc')).replace(/\/\/.*$/gm, '')).id;
async function openActor(actor, room) {
  const res = await base44.fetchWithAuth(`/apps/${appId}/actors/${actor}/connection-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room, connection_id: crypto.randomUUID() }),
    fetch: (path, init) => fetch(`https://base44.app/api${path}`, init),
  });
  if (!res.ok) throw new Error(`token: ${res.status} ${await res.text()}`);
  const { websocket_url, token } = await res.json();
  const ws = new WebSocket(`${websocket_url}${websocket_url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`);
  const listeners = [];
  const queued = [];
  // Like the SDK: a ping every second (it also keeps large replies flowing).
  ws.onopen = () => { queued.splice(0).forEach((t) => ws.send(t)); setInterval(() => ws.readyState === 1 && ws.send('{"type":"__ping"}'), 1000); };
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type !== '__pong') listeners.forEach((f) => f(m)); };
  ws.onclose = (e) => log('socket closed', e.code, e.reason);
  return {
    subscribe: (f) => listeners.push(f),
    send: (m) => { const t = JSON.stringify(m); ws.readyState === 1 ? ws.send(t) : queued.push(t); },
    close: () => ws.close(),
  };
}
const conn = await openActor('DesignRoom', d.id);
const inbox = [];
const frags = new Map();
conn.subscribe((m) => {
  if (m?.type === 'frag') {
    const parts = frags.get(m.fid) ?? [];
    parts[m.i] = m.s;
    frags.set(m.fid, parts);
    if (parts.filter((x) => x !== undefined).length === m.n) inbox.push(JSON.parse(parts.join('')));
    return;
  }
  inbox.push(m);
});
const next = async (pred, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const i = inbox.findIndex(pred);
    if (i >= 0) return inbox.splice(i, 1)[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};
const sendBig = (msg) => {
  const text = JSON.stringify(msg);
  const fid = crypto.randomUUID();
  const n = Math.ceil(text.length / 400000);
  for (let i = 0; i < n; i++) conn.send({ type: 'frag', fid, i, n, s: text.slice(i * 400000, (i + 1) * 400000) });
};
const request = async (type, data = {}) => {
  const rid = crypto.randomUUID();
  const msg = { type, rid, ...data };
  if (JSON.stringify(msg).length > 400000) sendBig(msg); else conn.send(msg);
  return next((m) => m.type === 'reply' && m.rid === rid, 60000);
};

try {
  const t0 = Date.now();
  const hi = await next((m) => m.type === 'hi');
  check(hi.role === 'owner' && hi.empty === true, `actor greets the owner of an empty design (${Date.now() - t0} ms)`);
  const init = await request('init', { model: MODEL });
  check(init.ok, `set up the design ${init.error ?? ''}`);
  conn.send({ type: 'hello' });
  const w = await next((m) => m.type === 'welcome');
  check(Object.keys(w.model.objs).length === Object.keys(MODEL.objs).length, `welcome carries the design (${Object.keys(w.model.objs).length} objects)`);
  check(w.motors.some((m) => m.name.endsWith('live-check.eng') && m.content.includes('LiveCheck')), 'welcome carries the owner\'s motor');
  const stage = Object.entries(w.model.objs).find(([, o]) => o.t === 'stage')[0];
  const t1 = Date.now();
  conn.send({ type: 'ops', seq: 1, ops: [{ op: 'set', id: stage, v: { name: '<name>Live booster</name>' } }] });
  const ops = await next((m) => m.type === 'ops');
  check(ops.version === 1 && ops.seq === 1, `edit accepted and broadcast in ${Date.now() - t1} ms`);
  const big = 'x'.repeat(1_500_000);
  const t2 = Date.now();
  sendBig({ type: 'ops', seq: 2, ops: [{ op: 'put', id: 'att:big.png', t: '#att', p: 'doc', o: 2000, k: ['data'], v: { '@': '', data: big } }] });
  const echo = await next((m) => m.type === 'ops' && m.ops?.[0]?.id === 'att:big.png', 60000);
  check(echo.ops[0].v.data.length === big.length, `1.5 MB edit went up and came back in fragments (${Date.now() - t2} ms)`);
  const ex = await request('export');
  check(ex.ok && ex.data.model.objs['att:big.png'].v.data.length === big.length && ex.data.model.objs[stage].v.name === '<name>Live booster</name>', 'stored copy has both edits');
  const hist = await request('history');
  check(hist.ok && hist.data.groups.length >= 1, `edit history (${hist.data?.groups?.length} entries)`);
  const snaps = await request('snapshots');
  check(snaps.ok && snaps.data.length >= 1, 'saved copy kept');
  const del = await request('destroy');
  check(del.ok, 'owner deleted the design content');
} catch (e) {
  check(false, `actor: ${e.message}`);
} finally {
  conn.close();
  await call('designs', { action: 'delete', id: d.id }).catch(() => {});
  await call('motors', { action: 'delete', id: motor?.id }).catch(() => {});
  await call('flights', { action: 'delete', id: plan?.id }).catch(() => {});
  check(!(await call('designs', { action: 'list' })).some((x) => x.id === d.id), 'deleted design is gone from the list');
}
log(ok ? 'LIVE CHECK PASSED' : 'LIVE CHECK FAILED');
Deno.exit(ok ? 0 : 1);
