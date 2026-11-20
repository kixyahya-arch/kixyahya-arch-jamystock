import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Client minimal de l'API Stripe (REST, formulaire encodé), sans dépendance : seules quelques routes sont utilisées
 * (clients, sessions Checkout, PaymentIntents, moyens de paiement).
 */
export class StripeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: { error?: { code?: string; decline_code?: string; message?: string; payment_intent?: { id: string } } } = {},
  ) {
    super(message);
  }
}

type Params = Record<string, unknown>;

/** Encode un objet imbriqué à la manière de Stripe : a[b][0]=c. */
export function formEncode(params: Params, prefix = ''): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => out.push(typeof item === 'object' ? formEncode(item as Params, `${key}[${i}]`) : `${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`));
    else if (typeof v === 'object') out.push(formEncode(v as Params, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.filter(Boolean).join('&');
}

export class StripeClient {
  constructor(
    private readonly secretKey: string,
    private readonly apiBase = 'https://api.stripe.com',
  ) {}

  async request<T>(method: 'GET' | 'POST', path: string, params: Params = {}, idempotencyKey?: string): Promise<T> {
    const body = formEncode(params);
    const url = `${this.apiBase}/v1${path}${method === 'GET' && body ? `?${body}` : ''}`;
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${this.secretKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        'stripe-version': '2024-06-20',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: method === 'POST' ? body : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) throw new StripeError(res.status, json.error?.message ?? `Stripe ${res.status}`, json);
    return json;
  }
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> & { id: string; metadata?: Record<string, string> } };
}

/**
 * Vérifie la signature d'un webhook (en-tête Stripe-Signature : t=…,v1=…) sur le corps brut, avec une tolérance
 * de 5 minutes contre le rejeu. Renvoie l'événement, ou lève une erreur.
 */
export function verifyWebhook(payload: Buffer, header: string | undefined, secret: string, now = Date.now(), toleranceS = 300): StripeEvent {
  if (!header) throw new Error('Signature absente');
  const parts = header.split(',').map((p) => p.split('=') as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!t || !sigs.length) throw new Error('Signature mal formée');
  if (Math.abs(now / 1000 - t) > toleranceS) throw new Error('Signature trop ancienne');
  const expected = createHmac('sha256', secret).update(`${t}.`).update(payload).digest();
  const ok = sigs.some((s) => {
    const b = Buffer.from(s, 'hex');
    return b.length === expected.length && timingSafeEqual(b, expected);
  });
  if (!ok) throw new Error('Signature invalide');
  return JSON.parse(payload.toString('utf8')) as StripeEvent;
}

/** Signe un corps comme le fait Stripe (tests, outils). */
export function signWebhook(payload: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
}
