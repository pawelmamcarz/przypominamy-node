# przypominamy

Oficjalny klient [API SMS przypominamy.com](https://przypominamy.com/api) dla Node.js (≥ 18), Deno, Bun i Cloudflare Workers. Zero zależności, TypeScript, oparty o `fetch`.

Polska bramka SMS: jeden endpoint do wysyłki, historia, saldo, własny nadpis, webhooki podpisane HMAC. Pay-as-you-go, bez abonamentu.

```bash
npm install przypominamy
```

## Szybki start

```ts
import { Przypominamy } from 'przypominamy';

const sms = new Przypominamy(process.env.PRZYPOMINAMY_API_KEY!); // pk_live_…

const msg = await sms.send({
  to: '+48600100200',
  text: 'Przypominamy o wizycie jutro o 10:00.',
  reference: 'wizyta-4711',           // Twój identyfikator, wraca w webhookach
  idempotencyKey: 'wizyta-4711-1',    // retry nie wyśle SMS-a drugi raz
});

console.log(msg.id, msg.status, msg.cost_grosze); // msg_… queued 9
```

Klucz testowy `pk_test_` (25 SMS gratis na własne numery) dostaniesz od razu po założeniu konta na [app.przypominamy.com/register](https://app.przypominamy.com/register); klucz produkcyjny po pierwszym doładowaniu (od 50 zł).

## Wysyłka masowa

```ts
const batch = await sms.send({
  to: ['+48600100200', '+48600100201'],   // do 500 numerów
  text: 'Promocja -20% do niedzieli. Kod: SMS20',
  from: 'SKLEP',                          // nadpis z listy sms.senders()
});
console.log(batch.accepted, 'z', batch.count, 'przyjęto, koszt', batch.total_cost_grosze / 100, 'zł');
```

## Wysyłka odroczona

```ts
await sms.send({ to: '+48600100200', text: 'Wizyta dziś o 14:00.', sendAt: new Date('2026-09-18T08:00:00Z') });
```

## Status, historia, konto

```ts
const m = await sms.get('msg_qY08hZ2mmDXAazdRTytS');
const page = await sms.list({ status: 'delivered', limit: 50 });   // page.data, page.next_cursor
const acc = await sms.account();                                    // acc.balance_grosze, acc.price_per_part_grosze
const { data: senders } = await sms.senders();
await sms.setSender('ZDROWKO');
```

## Webhooki

```ts
const { webhook_secret } = await sms.setWebhook('https://twojadomena.pl/webhooks/sms');
```

W handlerze (Express — pamiętaj o surowym body):

```ts
import express from 'express';
import { verifyWebhook } from 'przypominamy';

app.post('/webhooks/sms', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = await verifyWebhook(req.body, req.header('X-Przypominamy-Signature'), process.env.PRZYPOMINAMY_WEBHOOK_SECRET!);
    // event.type: message.sent | message.delivered | message.undelivered | message.failed | message.expired
    console.log(event.type, event.data.message.id, event.data.message.reference);
    res.sendStatus(200);
  } catch {
    res.sendStatus(403);
  }
});
```

## Błędy

Każdy błąd API to `PrzypominamyError` z polami `status`, `code` (`invalid_request`, `unauthorized`, `insufficient_funds`, `rate_limited`, `idempotency_conflict`, `provider_error`…), `param`, `requestId` i `retryAfter`.

```ts
import { PrzypominamyError } from 'przypominamy';
try {
  await sms.send({ to: '+48600100200', text: 'Hej' });
} catch (e) {
  if (e instanceof PrzypominamyError && e.code === 'insufficient_funds') { /* doładuj konto */ }
}
```

## Nowe w API 2.1

Bramka ma od września 2026 także: anulowanie zaplanowanych wysyłek (`DELETE /v1/messages/{id}`, status `cancelled`), okno godzin `send_window` i ważność `expires_at` przy wysyłce, czarną listę z linkiem opt-out `{{opt_out}}` (`/v1/blacklist`), kontakty i grupy z personalizacją `{{imie}}` (`/v1/contacts`, `/v1/groups`, `to: "group:Nazwa"`) oraz zakresy klucza `send` / `read` / `manage`. SDK nie ma jeszcze metod dla tych endpointów ani publicznej metody do dowolnych żądań — wywołaj je bezpośrednio przez `fetch` z tym samym nagłówkiem `Authorization: Bearer …`, według [dokumentacji](https://przypominamy.com/api/docs). Metody SDK (`send`, `getMessage`…) działają bez zmian; pola `send_window` i `expires_at` w wysyłce oraz statusy `cancelled` i `rejected` w odpowiedziach przechodzą przez SDK jako zwykłe pola JSON.

## Dokumentacja

- [Strona API](https://przypominamy.com/api) · [Redoc](https://przypominamy.com/api/docs) · [OpenAPI 3.1](https://przypominamy.com/openapi.json)
- Wsparcie: support@przypominamy.com

MIT
