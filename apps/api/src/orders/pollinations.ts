import type { AppConfig } from '../config.js';
import { HiggsfieldError as VisuelError } from './higgsfield.js';

/**
 * Générateur gratuit Pollinations (pollinations.ai) : une seule requête GET dont la réponse est l'image. Sans clé,
 * le service est gratuit mais limité (une génération à la fois, image un peu réduite, petit logo Pollinations dans
 * un coin) ; une clé (POLLINATIONS_API_KEY) lève ces limites. Il ne prend pas les photos des meubles : seulement
 * leur description.
 */

type Cfg = AppConfig['pollinations'];
type Fetch = typeof fetch;

/** Au-delà, l'adresse devient trop longue pour certains serveurs. */
const MAX_PROMPT = 1500;

const SATURE = 'Service gratuit saturé (une image toutes les 45 secondes, partagée avec d’autres sites) : réessayez dans quelques minutes, ou ajoutez une clé Pollinations (POLLINATIONS_API_KEY)';

export class PollinationsClient {
  constructor(
    private readonly cfg: Cfg,
    private readonly fetchImpl: Fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  url(prompt: string, seed: number): string {
    const p = encodeURIComponent(prompt.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT));
    const u = new URL(this.cfg.url.replace('{prompt}', p));
    u.searchParams.set('model', this.cfg.model);
    u.searchParams.set('width', '1600');
    u.searchParams.set('height', '1000');
    u.searchParams.set('seed', String(seed));
    u.searchParams.set('nologo', 'true');
    u.searchParams.set('private', 'true');
    return u.toString();
  }

  /**
   * Génère l'image. Sans clé, Pollinations accepte une image toutes les 45 secondes par adresse IP et répond 402
   * (FREE_LIMIT, « Retry after 42s ») ou 429 au-delà ; sur un hébergeur, l'adresse est partagée avec d'autres
   * services : on attend le délai indiqué et on réessaie, dans la limite du délai total.
   */
  async generate(prompt: string, seed = 1 + Math.floor(Math.random() * 999_999)): Promise<Buffer> {
    const headers: Record<string, string> = { Accept: 'image/*' };
    if (this.cfg.key) headers.Authorization = `Bearer ${this.cfg.key}`;
    const deadline = Date.now() + this.cfg.timeoutMs;
    let limited = false;
    for (let attempt = 1; ; attempt++) {
      const left = deadline - Date.now();
      if (left <= 0) throw new VisuelError(limited ? SATURE : 'Génération trop longue, abandonnée : réessayez dans un moment');
      let res: Response;
      try {
        res = await this.fetchImpl(this.url(prompt, seed), { headers, signal: AbortSignal.timeout(Math.min(left, 120_000)) });
      } catch (e) {
        if (attempt < 3 && deadline - Date.now() > 10_000) {
          await this.sleep(5_000 * attempt);
          continue;
        }
        throw new VisuelError((e as Error).name === 'TimeoutError' ? 'Génération trop longue, abandonnée : réessayez dans un moment' : 'Service de génération injoignable');
      }
      if (res.ok && (res.headers.get('content-type') ?? '').startsWith('image/')) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 30 * 1024 * 1024) throw new VisuelError('Image trop lourde', false);
        return buf;
      }
      const body = (await res.text().catch(() => '')).replace(/\s+/g, ' ');
      if (res.status === 401 || res.status === 403) throw new VisuelError(`Clé Pollinations refusée : vérifiez POLLINATIONS_API_KEY (${body.slice(0, 160)})`, false);
      if (res.status === 402 || res.status === 429 || res.status >= 500) {
        limited ||= res.status === 402 || res.status === 429;
        // délai annoncé (« Retry after 42s » ou en-tête Retry-After), sinon 10 s ; un peu d'aléa entre les essais
        const announced = Number(res.headers.get('retry-after')) || Number(/retry after (\d+)\s*s/i.exec(body)?.[1]) || 10;
        const wait = Math.min(announced * 1000 + 1_000 + Math.random() * 3_000, 60_000);
        if (attempt < 10 && Date.now() + wait < deadline - 5_000) {
          await this.sleep(wait);
          continue;
        }
        if (limited) throw new VisuelError(SATURE);
      }
      if (res.ok) throw new VisuelError('Le service de génération n’a pas renvoyé d’image');
      throw new VisuelError(`Service de génération indisponible (HTTP ${res.status})`);
    }
  }
}
