import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Przypominamy, PrzypominamyError, verifyWebhook } from '../dist/index.js';

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return { fetchImpl, calls };
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

test('send: pojedynczy odbiorca → POST /v1/messages z Bearer i Idempotency-Key', async () => {
  const { fetchImpl, calls } = fakeFetch(() => json({ id: 'msg_1', status: 'queued', to: '+48600100200' }, 201));
  const sms = new Przypominamy('pk_live_test', { fetch: fetchImpl });
  const msg = await sms.send({ to: '+48600100200', text: 'Hej', reference: 'r1', idempotencyKey: 'k1', sendAt: new Date('2026-09-10T08:00:00Z') });
  assert.equal(msg.id, 'msg_1');
  assert.equal(calls[0].url, 'https://api.przypominamy.com/v1/messages');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer pk_live_test');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'k1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { to: '+48600100200', text: 'Hej', reference: 'r1', send_at: '2026-09-10T08:00:00.000Z' });
});

test('send: tablica odbiorców → wynik zbiorczy', async () => {
  const { fetchImpl } = fakeFetch(() => json({ count: 2, accepted: 2, total_cost_grosze: 18, messages: [] }, 201));
  const sms = new Przypominamy('pk_live_test', { fetch: fetchImpl });
  const res = await sms.send({ to: ['+48600100200', '+48600100201'], text: 'Hej' });
  assert.equal(res.count, 2);
});

test('błąd API → PrzypominamyError z kodem, param i request_id', async () => {
  const { fetchImpl } = fakeFetch(() =>
    json({ error: { code: 'insufficient_funds', message: 'Brak środków', param: undefined }, request_id: 'req_x' }, 402, { 'Retry-After': '30' }),
  );
  const sms = new Przypominamy('pk_live_test', { fetch: fetchImpl });
  await assert.rejects(sms.send({ to: '+48600100200', text: 'Hej' }), (e) => {
    assert.ok(e instanceof PrzypominamyError);
    assert.equal(e.status, 402);
    assert.equal(e.code, 'insufficient_funds');
    assert.equal(e.requestId, 'req_x');
    assert.equal(e.retryAfter, 30);
    return true;
  });
});

test('list buduje query string, account/senders/setWebhook trafiają w dobre ścieżki', async () => {
  const { fetchImpl, calls } = fakeFetch((url) => {
    if (url.includes('/v1/messages?')) return json({ data: [], next_cursor: null });
    if (url.endsWith('/v1/account')) return json({ id: 'cl_1', balance_grosze: 100 });
    if (url.endsWith('/v1/senders')) return json({ data: [{ name: 'PRZYPOMINAM', is_default: false }], current: null });
    if (url.endsWith('/v1/account/webhook')) return json({ webhook_url: 'https://x', webhook_secret: 'whsec_1' });
    return json({}, 404);
  });
  const sms = new Przypominamy('pk_live_test', { fetch: fetchImpl });
  await sms.list({ limit: 10, status: 'delivered', reference: 'r1' });
  assert.equal(calls[0].url, 'https://api.przypominamy.com/v1/messages?limit=10&status=delivered&reference=r1');
  assert.equal((await sms.account()).balance_grosze, 100);
  assert.equal((await sms.senders()).data[0].name, 'PRZYPOMINAM');
  const wh = await sms.setWebhook('https://x');
  assert.equal(wh.webhook_secret, 'whsec_1');
  assert.equal(calls[3].init.method, 'PUT');
});

test('verifyWebhook akceptuje poprawny podpis i odrzuca zły oraz stary', async () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_1', type: 'message.delivered', created_at: 'x', data: { message: { id: 'msg_1' } } });
  const t = 1_757_230_000;
  const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const ev = await verifyWebhook(body, `t=${t},v1=${sig}`, secret, { now: t + 10 });
  assert.equal(ev.data.message.id, 'msg_1');
  await assert.rejects(verifyWebhook(body, `t=${t},v1=${'0'.repeat(64)}`, secret, { now: t + 10 }), /Nieprawidłowy podpis/);
  await assert.rejects(verifyWebhook(body, `t=${t},v1=${sig}`, secret, { now: t + 1000 }), /przeterminowany/);
});
