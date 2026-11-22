import type { AppConfig } from '../config.js';

/**
 * Client de l'API Higgsfield (docs.higgsfield.ai) : envoi d'une génération, suivi par interrogation de son
 * adresse de statut (2 s, puis ×1,5 jusqu'à 10 s, avec un peu d'aléa), puis téléchargement de l'image, dont le
 * lien expire après 7 jours chez Higgsfield. Les photos de référence passent par un lien de dépôt signé.
 * Une génération échouée ou refusée (nsfw) n'est pas facturée par Higgsfield.
 */

type Cfg = AppConfig['higgsfield'];
type Fetch = typeof fetch;

export class HiggsfieldError extends Error {
  constructor(
    message: string,
    /** false : inutile de réessayer (identifiants, refus du modèle) */
    readonly retry = true,
  ) {
    super(message);
  }
}

interface Status {
  status?: string;
  request_id?: string;
  status_url?: string;
  error?: string | null;
  images?: { url?: string }[];
}

const TERMINAL = new Set(['completed', 'failed', 'nsfw', 'canceled', 'cancelled']);

export class HiggsfieldClient {
  constructor(
    private readonly cfg: Cfg,
    private readonly fetchImpl: Fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  get enabled(): boolean {
    return !!(this.cfg.keyId && this.cfg.keySecret);
  }

  get usesReferences(): boolean {
    return !!this.cfg.imageField;
  }

  private auth() {
    return { Authorization: `Key ${this.cfg.keyId}:${this.cfg.keySecret}` };
  }

  private async json<T>(res: Response, what: string): Promise<T> {
    if (res.status === 401 || res.status === 403) throw new HiggsfieldError('Clé Higgsfield refusée : vérifiez HIGGSFIELD_API_KEY_ID et HIGGSFIELD_API_KEY_SECRET', false);
    if (res.status === 402) throw new HiggsfieldError('Solde Higgsfield insuffisant', false);
    if (res.status === 422 || res.status === 400) {
      const body = await res.text().catch(() => '');
      throw new HiggsfieldError(`Requête refusée par Higgsfield (${what}) : ${body.slice(0, 160)}`, false);
    }
    if (!res.ok) throw new HiggsfieldError(`Higgsfield indisponible (${what}, HTTP ${res.status})`);
    return (await res.json()) as T;
  }

  /** Dépose une photo chez Higgsfield et renvoie son adresse publique, à passer au modèle. */
  async upload(jpeg: Buffer): Promise<string> {
    const r = await this.json<{ public_url?: string; upload_url?: string; upload_headers?: Record<string, string> }>(
      await this.fetchImpl(`${this.cfg.baseUrl}/files/generate-upload-url`, {
        method: 'POST',
        headers: { ...this.auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_type: 'image/jpeg' }),
        signal: AbortSignal.timeout(30_000),
      }),
      'dépôt de photo',
    );
    if (!r.upload_url || !r.public_url) throw new HiggsfieldError('Réponse de dépôt incomplète');
    // le dépôt signé ne prend pas la clé Higgsfield
    const put = await this.fetchImpl(r.upload_url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', ...(r.upload_headers ?? {}) }, body: new Uint8Array(jpeg), signal: AbortSignal.timeout(60_000) });
    if (!put.ok) throw new HiggsfieldError(`Dépôt de photo refusé (HTTP ${put.status})`);
    return r.public_url;
  }

  /** Corps de la requête : prompt, format, photos de référence selon le champ configuré, paramètres libres. */
  body(prompt: string, references: string[]): Record<string, unknown> {
    const b: Record<string, unknown> = { prompt, aspect_ratio: this.cfg.aspectRatio, ...this.cfg.params };
    const f = this.cfg.imageField;
    if (f && references.length) b[f] = /s$/.test(f) ? references : references[0];
    return b;
  }

  async submit(body: Record<string, unknown>, idempotencyKey: string): Promise<{ requestId: string; statusUrl: string }> {
    const r = await this.json<Status>(
      await this.fetchImpl(`${this.cfg.baseUrl}/${this.cfg.model}`, {
        method: 'POST',
        headers: { ...this.auth(), 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      }),
      'génération',
    );
    if (!r.request_id) throw new HiggsfieldError('Réponse de génération sans identifiant');
    return { requestId: r.request_id, statusUrl: r.status_url || `${this.cfg.baseUrl}/requests/${r.request_id}/status` };
  }

  /** Attend la fin de la génération ; renvoie l'adresse de l'image. */
  async wait(statusUrl: string): Promise<string> {
    const deadline = Date.now() + this.cfg.timeoutMs;
    let delay = this.cfg.pollMs;
    let failures = 0;
    for (;;) {
      await this.sleep(delay + Math.random() * Math.min(500, delay / 4));
      delay = Math.min(delay * 1.5, Math.max(this.cfg.pollMs, 10_000));
      let s: Status;
      try {
        const res = await this.fetchImpl(statusUrl, { headers: this.auth(), signal: AbortSignal.timeout(30_000) });
        if (res.status === 404) throw new HiggsfieldError('Génération introuvable chez Higgsfield', false);
        s = await this.json<Status>(res, 'suivi');
        failures = 0;
      } catch (e) {
        if (e instanceof HiggsfieldError && !e.retry) throw e;
        if (++failures >= 5) throw e instanceof HiggsfieldError ? e : new HiggsfieldError('Higgsfield ne répond plus');
        s = {};
      }
      const st = s.status ?? '';
      if (TERMINAL.has(st)) {
        if (st === 'completed') {
          const url = s.images?.find((i) => i.url)?.url;
          if (!url) throw new HiggsfieldError('Génération terminée sans image', false);
          return url;
        }
        if (st === 'nsfw') throw new HiggsfieldError('Image refusée par le filtre de contenu de Higgsfield', false);
        throw new HiggsfieldError(s.error ? `Échec de la génération : ${String(s.error).slice(0, 160)}` : 'Échec de la génération', false);
      }
      if (Date.now() > deadline) throw new HiggsfieldError('Génération trop longue, abandonnée', false);
    }
  }

  async download(url: string): Promise<Buffer> {
    const u = new URL(url);
    if (u.protocol !== 'https:' && !this.cfg.baseUrl.startsWith('http://')) throw new HiggsfieldError('Adresse d’image inattendue', false);
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new HiggsfieldError(`Téléchargement de l’image impossible (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 30 * 1024 * 1024) throw new HiggsfieldError('Image trop lourde', false);
    return buf;
  }
}

/** Noms anglais des pièces courantes, pour le prompt. */
const PIECE_EN: Record<string, string> = {
  Entrée: 'entrance hall',
  Séjour: 'living room',
  Salon: 'living room',
  'Salle à manger': 'dining room',
  Cuisine: 'kitchen',
  'Chambre parentale': 'master bedroom',
  Chambre: 'bedroom',
  'Chambre enfant': "child's bedroom",
  Bureau: 'home office',
  'Salle de bain': 'bathroom',
  "Salle d'eau": 'shower room',
  WC: 'toilet room',
  Dressing: 'walk-in closet',
  Buanderie: 'laundry room',
  'Balcon / terrasse': 'balcony terrace',
  Jardin: 'garden',
  Accueil: 'reception area',
  'Espace de vente': 'sales showroom',
};

/** « Chambre 2 » → bedroom ; une pièce inconnue garde son nom français. */
export function pieceEnglish(piece: string): string {
  const base = piece.replace(/\s+\d+$/, '');
  return PIECE_EN[base] ?? `room called "${piece}"`;
}

const PRO = new Set(['Accueil', 'Espace de vente', 'Bureau']);

/**
 * Prompt en anglais (mieux suivi par les modèles) : la pièce, ses meubles regroupés (« Chaise visiteur 5 » et
 * « Chaise visiteur 6 » deviennent « 2 × Chaise visiteur »), leurs dimensions, la description du pack.
 */
export function ambiancePrompt(p: { piece: string; description: string | null; biens: { libelle: string; dimensions: string | null }[]; references: number }): string {
  const groups = new Map<string, { n: number; dimensions: string | null }>();
  for (const b of p.biens.slice(0, 40)) {
    const name = b.libelle.replace(/\s+(n°\s*)?\d+$/i, '').trim() || b.libelle;
    const key = `${name}|${b.dimensions ?? ''}`;
    const g = groups.get(key);
    if (g) g.n++;
    else groups.set(key, { n: 1, dimensions: b.dimensions });
  }
  const list = [...groups]
    .slice(0, 20)
    .map(([k, g]) => `- ${g.n > 1 ? `${g.n} × ` : ''}${k.split('|')[0]}${g.dimensions ? ` (${g.dimensions.replace(/,/g, '.').replace(/ m$/, ' metres')})` : ''}`)
    .join('\n');
  const base = p.piece.replace(/\s+\d+$/, '');
  const setting = PRO.has(base) ? 'in a French real-estate sales office' : 'in a French apartment staged as a show flat';
  return [
    `Photorealistic interior design photograph of a furnished ${pieceEnglish(p.piece)} ${setting}.`,
    `The room contains exactly these pieces of furniture, nothing else of importance:`,
    list,
    p.references ? `The reference images show the actual furniture: reproduce each piece faithfully (shape, colour, material).` : '',
    p.description ? `Context from the client: ${p.description.slice(0, 300)}` : '',
    `Natural daylight, neutral walls and floor, eye-level wide-angle view, realistic proportions, no people, no text, no watermark.`,
  ]
    .filter(Boolean)
    .join('\n');
}
