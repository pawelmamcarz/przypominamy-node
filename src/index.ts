/**
 * Oficjalny klient API SMS przypominamy.com dla Node.js / Deno / Bun / przeglądarki (fetch).
 *
 *   import { Przypominamy } from 'przypominamy';
 *   const sms = new Przypominamy(process.env.PRZYPOMINAMY_API_KEY!);
 *   const msg = await sms.send({ to: '+48600100200', text: 'Przypominamy o wizycie jutro o 10:00.' });
 *
 * Dokumentacja: https://przypominamy.com/api/docs
 */

export type MessageStatus =
  | 'scheduled'
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'undelivered'
  | 'failed'
  | 'expired'
  | 'rejected';

export interface Message {
  id: string;
  status: MessageStatus;
  to: string;
  from: string | null;
  text: string;
  parts: number;
  cost_grosze: number;
  reference: string | null;
  send_at: string | null;
  delivered_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface BatchResult {
  count: number;
  accepted: number;
  total_cost_grosze: number;
  messages: Message[];
}

export interface SendOptions {
  /** Numer odbiorcy (E.164, np. "+48600100200") lub tablica do 500 numerów. */
  to: string | string[];
  /** Treść, do 1000 znaków. Polskie znaki dozwolone. */
  text: string;
  /** Nadpis (nazwa nadawcy), musi być aktywny — patrz `senders()`. */
  from?: string;
  /** Wysyłka odroczona: Date lub ISO 8601, do 90 dni w przód. */
  sendAt?: Date | string;
  /** Twój identyfikator (np. id wizyty), do 128 znaków. Wraca w webhookach. */
  reference?: string;
  /** Klucz idempotencji: retry z tym samym kluczem nie wyśle SMS-a drugi raz. */
  idempotencyKey?: string;
}

export interface ListOptions {
  limit?: number;
  status?: MessageStatus;
  reference?: string;
  to?: string;
  cursor?: string;
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export interface Account {
  id: string;
  name: string;
  sender_name: string | null;
  balance_grosze: number;
  credit_limit_grosze: number;
  price_per_part_grosze: number;
  rate_limit_per_minute: number;
  webhook_url: string | null;
  status: 'active' | 'suspended' | 'closed';
}

export interface Sender {
  name: string;
  is_default: boolean;
}

export interface WebhookConfig {
  webhook_url: string | null;
  webhook_secret: string | null;
  signature_header?: string;
}

export type WebhookEventType =
  | 'message.sent'
  | 'message.delivered'
  | 'message.undelivered'
  | 'message.failed'
  | 'message.expired';

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  created_at: string;
  data: { message: Message };
}

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'invalid_request'
  | 'insufficient_funds'
  | 'rate_limited'
  | 'idempotency_conflict'
  | 'provider_error'
  | 'internal_error';

/** Błąd zwrócony przez API — z kodem HTTP, kodem błędu i identyfikatorem żądania do supportu. */
export class PrzypominamyError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode | 'network_error',
    message: string,
    public readonly param?: string,
    public readonly requestId?: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'PrzypominamyError';
  }
}

export interface ClientOptions {
  /** Domyślnie https://api.przypominamy.com */
  baseUrl?: string;
  /** Timeout żądania w ms (domyślnie 10 000). */
  timeoutMs?: number;
  /** Własna implementacja fetch (testy, starsze środowiska). */
  fetch?: typeof fetch;
}

export class Przypominamy {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, options: ClientOptions = {}) {
    if (!apiKey) throw new Error('Brak klucza API (pk_live_…)');
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? 'https://api.przypominamy.com').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /** Wyślij SMS do jednego odbiorcy. */
  send(options: SendOptions & { to: string }): Promise<Message>;
  /** Wyślij SMS do wielu odbiorców (do 500). */
  send(options: SendOptions & { to: string[] }): Promise<BatchResult>;
  async send(options: SendOptions): Promise<Message | BatchResult> {
    const body: Record<string, unknown> = { to: options.to, text: options.text };
    if (options.from) body.from = options.from;
    if (options.reference) body.reference = options.reference;
    if (options.sendAt) body.send_at = options.sendAt instanceof Date ? options.sendAt.toISOString() : options.sendAt;
    const headers: Record<string, string> = {};
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    return this.request('POST', '/v1/messages', body, headers);
  }

  /** Pobierz wiadomość po id (`msg_…`). */
  get(id: string): Promise<Message> {
    return this.request('GET', `/v1/messages/${encodeURIComponent(id)}`);
  }

  /** Historia wiadomości, od najnowszych. Do kolejnej strony przekaż `cursor` z `next_cursor`. */
  list(options: ListOptions = {}): Promise<Page<Message>> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(options)) if (v != null) q.set(k, String(v));
    const qs = q.toString();
    return this.request('GET', `/v1/messages${qs ? `?${qs}` : ''}`);
  }

  /** Saldo, cennik i ustawienia konta. */
  account(): Promise<Account> {
    return this.request('GET', '/v1/account');
  }

  /** Aktywne nadpisy (nazwy nadawcy) do użycia w `from`. */
  async senders(): Promise<{ data: Sender[]; current: string | null }> {
    return this.request('GET', '/v1/senders');
  }

  /** Ustaw domyślny nadpis konta (`null` przywraca domyślny). */
  setSender(senderName: string | null): Promise<{ id: string; sender_name: string | null }> {
    return this.request('PATCH', '/v1/account', { sender_name: senderName });
  }

  /** Ustaw adres webhooka. Zwraca sekret do weryfikacji podpisu. `null` wyłącza webhooki. */
  setWebhook(url: string | null, options: { rotateSecret?: boolean } = {}): Promise<WebhookConfig> {
    return this.request('PUT', '/v1/account/webhook', { url, rotate_secret: options.rotateSecret === true });
  }

  private async request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      'User-Agent': 'przypominamy-node/2.0.0',
      ...extraHeaders,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new PrzypominamyError(0, 'network_error', e instanceof Error ? e.message : String(e));
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* nie-JSON */
    }

    if (!res.ok) {
      const err = (json as { error?: { code?: ErrorCode; message?: string; param?: string }; request_id?: string }) ?? {};
      const retryAfter = res.headers.get('Retry-After');
      throw new PrzypominamyError(
        res.status,
        err.error?.code ?? 'internal_error',
        err.error?.message ?? `HTTP ${res.status}`,
        err.error?.param,
        err.request_id ?? res.headers.get('X-Request-Id') ?? undefined,
        retryAfter ? Number(retryAfter) : undefined,
      );
    }
    return json as T;
  }
}

// ── Webhooki: weryfikacja podpisu ─────────────────────────────────────────

/**
 * Weryfikuje nagłówek `X-Przypominamy-Signature` (`t=<unix>,v1=<hex>`) dla surowego body.
 * Działa w Node ≥ 18, Deno, Bun i Workers (Web Crypto). Zwraca sparsowane zdarzenie albo rzuca.
 */
export async function verifyWebhook(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
  options: { toleranceSeconds?: number; now?: number } = {},
): Promise<WebhookEvent> {
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const m = /t=(\d+),v1=([0-9a-f]{64})/.exec(signatureHeader ?? '');
  if (!m) throw new Error('Brak lub nieprawidłowy nagłówek X-Przypominamy-Signature');
  const t = Number(m[1]);
  if (Math.abs(now - t) > tolerance) throw new Error('Podpis webhooka jest przeterminowany');

  const enc = new TextEncoder();
  const bodyBytes = typeof rawBody === 'string' ? enc.encode(rawBody) : rawBody;
  const payload = new Uint8Array(enc.encode(`${t}.`).length + bodyBytes.length);
  payload.set(enc.encode(`${t}.`), 0);
  payload.set(bodyBytes, enc.encode(`${t}.`).length);

  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, payload));
  const expected = Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
  if (!timingSafeEqual(expected, m[2]!)) throw new Error('Nieprawidłowy podpis webhooka');

  return JSON.parse(typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody)) as WebhookEvent;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default Przypominamy;
