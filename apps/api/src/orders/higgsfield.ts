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

/** Message d'erreur renvoyé par Higgsfield (`detail`, ou le texte brut), raccourci. */
async function detailOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  let detail: unknown = text;
  try {
    const j = JSON.parse(text) as { detail?: unknown; message?: unknown; error?: unknown };
    detail = j.detail ?? j.message ?? j.error ?? text;
  } catch {
    /* corps non JSON */
  }
  return (typeof detail === 'string' ? detail : JSON.stringify(detail)).replace(/\s+/g, ' ').trim().slice(0, 160);
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

  /**
   * Codes d'erreur documentés par Higgsfield (docs/concepts/errors) : 401 identifiants invalides, 403 solde
   * insuffisant, 404 modèle inconnu pour ce compte, 400/422 paramètres refusés. Le corps est `{"detail": "..."}`.
   */
  private async json<T>(res: Response, what: string): Promise<T> {
    if (res.ok) return (await res.json()) as T;
    const detail = await detailOf(res);
    const d = detail ? ` (Higgsfield : « ${detail} »)` : '';
    if (res.status === 401) throw new HiggsfieldError(`Clé Higgsfield refusée : vérifiez HIGGSFIELD_API_KEY_ID et HIGGSFIELD_API_KEY_SECRET${d}`, false);
    if (res.status === 402 || res.status === 403) throw new HiggsfieldError(`Solde API Higgsfield insuffisant : ajoutez des crédits sur console.higgsfield.ai${d}`, false);
    if (res.status === 404) throw new HiggsfieldError(`Modèle « ${this.cfg.model} » introuvable chez Higgsfield : vérifiez HIGGSFIELD_MODEL${d}`, false);
    if (res.status === 422 || res.status === 400) throw new HiggsfieldError(`Requête refusée par Higgsfield (${what})${d}`, false);
    throw new HiggsfieldError(`Higgsfield indisponible (${what}, HTTP ${res.status})${d}`);
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

/** Limite de mot qui tient compte des lettres accentuées (\b de JavaScript s'arrête aux lettres ASCII). */
const B = '(?:(?<![\\p{L}\\d])(?=[\\p{L}\\d])|(?<=[\\p{L}\\d])(?![\\p{L}\\d]))';
const ub = (list: [RegExp, string][]): [RegExp, string][] => list.map(([re, en]) => [new RegExp(re.source.replace(/\\b/g, B), 'u'), en]);

/** Vocabulaire courant du mobilier, du plus précis au plus général : les modèles comprennent mal le français. */
const MEUBLES_EN = ub([
  [/\bbanque d['’]accueil\b/, 'reception desk'],
  [/\btable basse\b/, 'coffee table'],
  [/\btable de (réunion|reunion)\b/, 'meeting table'],
  [/\btable à manger\b|\btable de salle à manger\b/, 'dining table'],
  [/\btable de chevet\b|\bchevet\b/, 'bedside table'],
  [/\bmeuble (tv|télé)\b/, 'TV stand'],
  [/\bmeuble\b/, 'cabinet'],
  [/\btotem( plv)?\b/, 'tall freestanding advertising display totem'],
  [/\bkakemono\b|\broll[- ]?up\b/, 'roll-up banner stand'],
  [/\bplv\b/, 'point-of-sale display'],
  [/\bcanapé d['’]angle\b/, 'corner sofa'],
  [/\bcanapé\b/, 'sofa'],
  [/\bfauteuil\b/, 'armchair'],
  [/\bchaise\b/, 'chair'],
  [/\btabouret( de bar)?\b/, 'bar stool'],
  [/\bpouf\b/, 'pouf'],
  [/\bbanquette\b/, 'bench seat'],
  [/\bbureau\b/, 'desk'],
  [/\bcomptoir\b/, 'counter'],
  [/\btable\b/, 'table'],
  [/\blit\b/, 'bed'],
  [/\bmatelas\b/, 'mattress'],
  [/\barmoire\b|\bpenderie\b/, 'wardrobe'],
  [/\bcommode\b/, 'chest of drawers'],
  [/\bbuffet\b|\bbahut\b/, 'sideboard'],
  [/\bbibliothèque\b/, 'bookcase'],
  [/\bétagère\b/, 'shelving unit'],
  [/\bvitrine\b/, 'display cabinet'],
  [/\bcaisson\b/, 'drawer pedestal'],
  [/\blampadaire\b/, 'floor lamp'],
  [/\blampe\b|\bluminaire\b|\bsuspension\b/, 'lamp'],
  [/\btapis\b/, 'rug'],
  [/\bmiroir\b/, 'mirror'],
  [/\bplante\b/, 'potted plant'],
  [/\bécran\b|\btélévision\b|\btv\b/, 'screen'],
  [/\btableau\b|\bcadre\b/, 'framed picture'],
  [/\brideau(x)?\b/, 'curtains'],
]);
const QUALIFS_EN = ub([
  [/\bgrise?s?\b/, 'grey'],
  [/\bnoire?s?\b/, 'black'],
  [/\bblanc(he)?s?\b/, 'white'],
  [/\bbleue?s?\b/, 'blue'],
  [/\bverte?s?\b/, 'green'],
  [/\brouges?\b/, 'red'],
  [/\bbois\b|\bchêne\b/, 'wooden'],
  [/\bcuir\b/, 'leather'],
  [/\bvelours\b/, 'velvet'],
  [/\bvisiteurs?\b/, 'visitor'],
  [/\bclients?\b/, 'client'],
  [/\b(de )?(réunion|reunion)\b/, 'meeting'],
  [/\bd['’]accueil\b/, 'reception'],
  [/\bde bureau\b/, 'office'],
  [/\bdouble\b|\b2 places\b/, 'double'],
  [/\b3 places\b/, 'three-seater'],
]);

/** « Chaise visiteur » → « visitor chair » ; un nom inconnu reste tel quel. */
export function meubleEnglish(libelle: string): string {
  const l = libelle.toLowerCase();
  const nom = MEUBLES_EN.find(([re]) => re.test(l));
  if (!nom) return libelle;
  const qualifs = QUALIFS_EN.filter(([re]) => re.test(l.replace(nom[0], ' '))).map(([, en]) => en);
  return [...new Set(qualifs)].concat(nom[1]).join(' ');
}

/**
 * Prompt en anglais (mieux suivi par les modèles) : la pièce, ses meubles regroupés (« Chaise visiteur 5 » et
 * « Chaise visiteur 6 » deviennent « 2 × visitor chair »), leurs dimensions, la description du pack. La version
 * courte, pour les modèles gratuits, garde l'essentiel en une phrase.
 */
export function ambiancePrompt(p: { piece: string; description: string | null; biens: { libelle: string; dimensions: string | null }[]; references: number; court?: boolean }): string {
  const groups = new Map<string, { n: number; dimensions: string | null }>();
  for (const b of p.biens.slice(0, 40)) {
    const name = meubleEnglish(b.libelle.replace(/\s+(n°\s*)?\d+$/i, '').trim() || b.libelle);
    const key = `${name}|${b.dimensions ?? ''}`;
    const g = groups.get(key);
    if (g) g.n++;
    else groups.set(key, { n: 1, dimensions: b.dimensions });
  }
  const metres = (d: string) => d.replace(/,/g, '.').replace(/ m$/, ' m');
  const base = p.piece.replace(/\s+\d+$/, '');
  const setting = PRO.has(base) ? 'in a French real-estate sales office' : 'in a French apartment staged as a show flat';
  if (p.court) {
    const items = [...groups]
      .slice(0, 12)
      .map(([k, g]) => `${g.n > 1 ? `${g.n} ` : 'one '}${k.split('|')[0]}${g.n > 1 ? 's' : ''}${g.dimensions ? ` (${metres(g.dimensions)})` : ''}`)
      .join(', ');
    return [
      `Photorealistic wide-angle interior photograph of a ${pieceEnglish(p.piece)} ${setting}, furnished only with ${items}.`,
      p.description ? `Context: ${p.description.slice(0, 160)}.` : '',
      `Minimal uncluttered space, natural daylight, neutral walls and floor, realistic scale, no people, no text.`,
    ]
      .filter(Boolean)
      .join(' ');
  }
  const list = [...groups]
    .slice(0, 20)
    .map(([k, g]) => `- ${g.n > 1 ? `${g.n} × ` : ''}${k.split('|')[0]}${g.dimensions ? ` (${g.dimensions.replace(/,/g, '.').replace(/ m$/, ' metres')})` : ''}`)
    .join('\n');
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
