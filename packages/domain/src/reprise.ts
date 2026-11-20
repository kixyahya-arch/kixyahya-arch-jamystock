/**
 * Reprise des données d'un ancien logiciel de stock (export CSV de Monstock / « JAMYSO STOCK » ou tableur maison).
 *
 * Les en-têtes sont reconnus par alias (accents, casse et ponctuation ignorés), si bien qu'un export brut se charge
 * sans retouche. Une ligne = un produit ; une quantité N > 1 donne N articles distincts (JAMYSTOCK suit chaque objet
 * individuellement, avec son propre QR), numérotés « libellé (1/N) ».
 */

export interface RepriseIssue {
  line: number;
  message: string;
}

export interface RepriseArticleRow {
  line: number;
  /** Identifiant stable dans l'ancien logiciel (référence, code-barres ou n° de ligne) : rend l'import rejouable. */
  origine: string;
  client: string;
  projet: string | null;
  libelle: string;
  reference: string | null;
  codeBarres: string | null;
  categorie: string | null;
  description: string | null;
  quantite: number;
  emplacement: string | null;
  longueurM: number | null;
  largeurM: number | null;
  hauteurM: number | null;
  poidsKg: number | null;
  etat: 'NEUF' | 'BON' | 'USE' | 'ENDOMMAGE';
  /** EN_STOCK : à l'entrepôt ; RESTITUE : installé chez le client (bureau de vente, appartement témoin…). */
  situation: 'EN_STOCK' | 'RESTITUE';
  dateEntree: string | null;
  photos: string[];
}

export interface RepriseClientRow {
  line: number;
  client: string;
  type: 'B2B' | 'B2C';
  siret: string | null;
  contactNom: string | null;
  email: string | null;
  telephone: string | null;
  adresse: string | null;
  projets: string[];
}

export interface RepriseParseResult<T> {
  rows: T[];
  errors: RepriseIssue[];
  /** Colonnes reconnues (champ → en-tête d'origine) et colonnes ignorées : affichées dans l'aperçu. */
  colonnes: Record<string, string>;
  ignorees: string[];
}

// ------------------------------------------------------------------ CSV

/** Découpe un CSV complet (cellules entre guillemets sur plusieurs lignes comprises). Renvoie les lignes avec leur n°. */
export function parseCsvRecords(text: string): { line: number; cells: string[] }[] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const counts = { ';': 0, ',': 0, '\t': 0 } as Record<string, number>;
  let q = false;
  for (const ch of firstLine) {
    if (ch === '"') q = !q;
    else if (!q && ch in counts) counts[ch]!++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
  const sep = n > 0 ? best : ';';
  const out: { line: number; cells: string[] }[] = [];
  let cells: string[] = [];
  let cur = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === '\n') line++;
        cur += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === sep) {
      cells.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      cells.push(cur);
      if (cells.some((c) => c.trim() !== '')) out.push({ line: startLine, cells: cells.map((c) => c.trim()) });
      cells = [];
      cur = '';
      line++;
      startLine = line;
    } else cur += ch;
  }
  cells.push(cur);
  if (cells.some((c) => c.trim() !== '')) out.push({ line: startLine, cells: cells.map((c) => c.trim()) });
  return out;
}

export function normalizeHeader(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function mapHeaders(header: string[], aliases: Record<string, string[]>) {
  const norm = header.map(normalizeHeader);
  const index: Record<string, number> = {};
  const colonnes: Record<string, string> = {};
  for (const [field, names] of Object.entries(aliases)) {
    const i = names
      .map(normalizeHeader)
      .map((n) => norm.indexOf(n))
      .find((x) => x >= 0);
    if (i != null && !Object.values(index).includes(i)) {
      index[field] = i;
      colonnes[field] = header[i]!;
    }
  }
  const used = new Set(Object.values(index));
  const ignorees = header.filter((h, i) => !used.has(i) && h.trim() !== '');
  return { index, colonnes, ignorees };
}

const num = (s: string): number | null => {
  if (!s) return null;
  const m = s
    .replace(/\s/g, '')
    .replace(',', '.')
    .match(/^(\d+(?:\.\d+)?)(?:[a-z²]{1,3})?$/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

/** Dimensions : un export en centimètres (valeur > 20 pour une longueur) est ramené en mètres. */
const metres = (s: string, unitCm: boolean): number | null => {
  const n = num(s);
  if (n == null || Number.isNaN(n)) return n;
  return unitCm || n > 20 ? Math.round(n) / 100 : n;
};

function date(s: string): string | null | 'invalide' {
  if (!s) return null;
  const fr = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (fr) {
    const y = fr[3]!.length === 2 ? `20${fr[3]}` : fr[3]!;
    const d = new Date(`${y}-${fr[2]!.padStart(2, '0')}-${fr[1]!.padStart(2, '0')}T${(fr[4] ?? '12').padStart(2, '0')}:${fr[5] ?? '00'}:00Z`);
    return Number.isNaN(d.getTime()) ? 'invalide' : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? 'invalide' : d.toISOString();
}

const SITUATIONS: Record<string, RepriseArticleRow['situation'] | 'SORTI'> = {
  en_stock: 'EN_STOCK',
  stock: 'EN_STOCK',
  entrepot: 'EN_STOCK',
  au_depot: 'EN_STOCK',
  chez_le_client: 'RESTITUE',
  client: 'RESTITUE',
  livre: 'RESTITUE',
  sur_site: 'RESTITUE',
  installe: 'RESTITUE',
  sorti: 'SORTI',
  detruit: 'SORTI',
  dechetterie: 'SORTI',
  donne: 'SORTI',
};

const ETATS: Record<string, RepriseArticleRow['etat']> = {
  neuf: 'NEUF',
  new: 'NEUF',
  bon: 'BON',
  bon_etat: 'BON',
  tres_bon_etat: 'BON',
  good: 'BON',
  use: 'USE',
  usage: 'USE',
  moyen: 'USE',
  used: 'USE',
  endommage: 'ENDOMMAGE',
  abime: 'ENDOMMAGE',
  casse: 'ENDOMMAGE',
  hs: 'ENDOMMAGE',
  damaged: 'ENDOMMAGE',
};

// ------------------------------------------------------------------ articles

export const ARTICLE_ALIASES: Record<string, string[]> = {
  libelle: ['libelle', 'designation', 'nom', 'nom du produit', 'produit', 'article', 'intitule', 'name', 'product', 'product name', 'nom produit'],
  reference: ['reference', 'ref', 'nom technique', 'sku', 'code article', 'reference interne', 'code produit', 'technical name'],
  codeBarres: [
    'code barre',
    'code barres',
    'code-barres',
    'codebarre',
    'ean',
    'barcode',
    'numero de serie',
    'n de serie',
    'serial number',
    'qr code',
    'etiquette',
  ],
  client: ['client', 'proprietaire', 'societe', 'entreprise', 'compte', 'contact', 'customer', 'owner', 'raison sociale'],
  projet: ['projet', 'chantier', 'programme', 'site client', 'project', 'affaire', 'residence'],
  categorie: ['categorie', 'famille', 'type', 'category', 'type de produit', 'sous categorie'],
  description: ['description', 'commentaire', 'commentaires', 'remarque', 'observations', 'notes', 'note', 'details'],
  quantite: ['quantite', 'qte', 'qty', 'quantity', 'stock', 'quantite en stock', 'stock reel', 'stock physique', 'nombre', 'nb'],
  emplacement: ['emplacement', 'localisation', 'adresse de stockage', 'location', 'rangement', 'case', 'position', 'bin'],
  longueurM: ['longueur', 'longueur m', 'longueur_m', 'long', 'l', 'length', 'profondeur'],
  largeurM: ['largeur', 'largeur m', 'largeur_m', 'larg', 'width'],
  hauteurM: ['hauteur', 'hauteur m', 'hauteur_m', 'haut', 'h', 'height'],
  longueurCm: ['longueur cm', 'longueur_cm', 'longueur (cm)', 'length cm'],
  largeurCm: ['largeur cm', 'largeur_cm', 'largeur (cm)', 'width cm'],
  hauteurCm: ['hauteur cm', 'hauteur_cm', 'hauteur (cm)', 'height cm'],
  poidsKg: ['poids', 'poids kg', 'poids_kg', 'weight', 'masse'],
  etat: ['etat', 'condition', 'state'],
  dateEntree: ['date entree', 'date d entree', 'date de reception', 'entree le', 'date de creation', 'cree le', 'created at', 'date'],
  situation: ['situation', 'statut', 'statut stock', 'etat du stock', 'ou est l objet'],
  photos: ['photo', 'photos', 'image', 'images', 'url photo', 'url image', 'picture', 'visuel'],
};

export interface RepriseArticleOptions {
  /** Client à utiliser quand le fichier n'a pas de colonne client (export d'un seul compte). */
  clientParDefaut?: string | null;
  /** Une quantité supérieure à ce plafond est refusée : c'est presque toujours une erreur de colonne. */
  quantiteMax?: number;
}

export function parseRepriseArticles(text: string, opts: RepriseArticleOptions = {}): RepriseParseResult<RepriseArticleRow> {
  const records = parseCsvRecords(text);
  const errors: RepriseIssue[] = [];
  const rows: RepriseArticleRow[] = [];
  if (!records.length) return { rows, errors: [{ line: 1, message: 'Fichier vide.' }], colonnes: {}, ignorees: [] };
  const [head, ...data] = records;
  const { index, colonnes, ignorees } = mapHeaders(head!.cells, ARTICLE_ALIASES);
  if (index.libelle == null) {
    return {
      rows,
      errors: [{ line: head!.line, message: 'Colonne du nom de l’objet introuvable (libellé, désignation, nom ou produit).' }],
      colonnes,
      ignorees,
    };
  }
  if (index.client == null && !opts.clientParDefaut) {
    return { rows, errors: [{ line: head!.line, message: 'Pas de colonne « client » : choisissez le client à qui appartient ce stock.' }], colonnes, ignorees };
  }
  const qMax = opts.quantiteMax ?? 500;
  const seen = new Map<string, number>();
  for (const r of data) {
    const get = (f: string) => (index[f] != null ? (r.cells[index[f]!] ?? '').trim() : '');
    const problems: string[] = [];
    const libelle = get('libelle');
    if (!libelle) problems.push('nom de l’objet manquant');
    const client = get('client') || opts.clientParDefaut || '';
    if (!client) problems.push('client manquant');
    const qRaw = get('quantite');
    const q = qRaw === '' ? 1 : num(qRaw);
    if (q == null || Number.isNaN(q) || !Number.isInteger(q)) problems.push(`quantité « ${qRaw} » invalide`);
    else if (q > qMax) problems.push(`quantité ${q} supérieure à ${qMax} : vérifiez la colonne`);
    const dims = {
      longueurM: index.longueurCm != null ? metres(get('longueurCm'), true) : metres(get('longueurM'), false),
      largeurM: index.largeurCm != null ? metres(get('largeurCm'), true) : metres(get('largeurM'), false),
      hauteurM: index.hauteurCm != null ? metres(get('hauteurCm'), true) : metres(get('hauteurM'), false),
    };
    if (Object.values(dims).some((x) => Number.isNaN(x))) problems.push('dimension invalide');
    const poids = num(get('poidsKg'));
    if (Number.isNaN(poids)) problems.push('poids invalide');
    const etatRaw = normalizeHeader(get('etat'));
    const etat = etatRaw ? ETATS[etatRaw] : 'BON';
    if (!etat) problems.push(`état « ${get('etat')} » inconnu (neuf, bon, usé ou endommagé)`);
    const sitRaw = normalizeHeader(get('situation'));
    const situation = sitRaw ? SITUATIONS[sitRaw] : 'EN_STOCK';
    if (!situation) problems.push(`situation « ${get('situation')} » inconnue (en stock, chez le client ou sorti)`);
    const d = date(get('dateEntree'));
    if (d === 'invalide') problems.push(`date « ${get('dateEntree')} » illisible`);
    const reference = get('reference') || null;
    const codeBarres = get('codeBarres') || null;
    const origine = codeBarres || reference ? `${clientKey(client)}|${reference ?? codeBarres}` : `${clientKey(client)}|${normalizeHeader(libelle)}|L${r.line}`;
    const dup = seen.get(origine);
    if (dup) problems.push(`même code que la ligne ${dup}`);
    if (problems.length) {
      errors.push({ line: r.line, message: problems.join(', ') });
      continue;
    }
    seen.set(origine, r.line);
    if (q === 0 || situation === 'SORTI') continue; // plus en stock, ou sorti (déchetterie, don) : rien à reprendre
    rows.push({
      line: r.line,
      origine,
      client,
      projet: get('projet') || null,
      libelle,
      reference,
      codeBarres,
      categorie: get('categorie') || null,
      description: get('description') || null,
      quantite: q!,
      emplacement: get('emplacement') || null,
      ...(dims as { longueurM: number | null; largeurM: number | null; hauteurM: number | null }),
      poidsKg: poids,
      etat: etat!,
      situation: situation as RepriseArticleRow['situation'],
      dateEntree: d as string | null,
      photos: get('photos')
        .split(/[\s,;|]+/)
        .filter((u) => /^https?:\/\//i.test(u)),
    });
  }
  return { rows, errors, colonnes, ignorees };
}

// ------------------------------------------------------------------ clients

export const CLIENT_ALIASES: Record<string, string[]> = {
  client: ['client', 'societe', 'entreprise', 'raison sociale', 'nom de la societe', 'company', 'organisation', 'compte', 'nom'],
  type: ['type', 'type de client', 'categorie client', 'particulier professionnel'],
  siret: ['siret', 'siren', 'n siret'],
  contactNom: ['contact', 'nom du contact', 'interlocuteur', 'nom contact', 'prenom nom', 'responsable', 'contact name'],
  email: ['email', 'e mail', 'mail', 'adresse email', 'courriel', 'identifiant', 'login'],
  telephone: ['telephone', 'tel', 'portable', 'mobile', 'phone'],
  adresse: ['adresse', 'adresse de facturation', 'address', 'adresse postale'],
  projets: ['projets', 'projet', 'chantiers', 'sites'],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseRepriseClients(text: string): RepriseParseResult<RepriseClientRow> {
  const records = parseCsvRecords(text);
  const errors: RepriseIssue[] = [];
  const rows: RepriseClientRow[] = [];
  if (!records.length) return { rows, errors: [{ line: 1, message: 'Fichier vide.' }], colonnes: {}, ignorees: [] };
  const [head, ...data] = records;
  const { index, colonnes, ignorees } = mapHeaders(head!.cells, CLIENT_ALIASES);
  if (index.client == null)
    return { rows, errors: [{ line: head!.line, message: 'Colonne « client » (ou société, raison sociale) introuvable.' }], colonnes, ignorees };
  const emails = new Map<string, number>();
  for (const r of data) {
    const get = (f: string) => (index[f] != null ? (r.cells[index[f]!] ?? '').trim() : '');
    const problems: string[] = [];
    const client = get('client');
    if (!client) problems.push('nom du client manquant');
    const email = get('email').toLowerCase() || null;
    if (email && !EMAIL_RE.test(email)) problems.push(`e-mail « ${email} » invalide`);
    const dup = email ? emails.get(email) : undefined;
    if (dup) problems.push(`e-mail déjà utilisé ligne ${dup}`);
    const t = normalizeHeader(get('type'));
    const siret = get('siret').replace(/\s/g, '') || null;
    const type: 'B2B' | 'B2C' = /particulier|b2c|prive/.test(t) ? 'B2C' : /pro|b2b|entreprise|societe/.test(t) || siret ? 'B2B' : 'B2B';
    if (problems.length) {
      errors.push({ line: r.line, message: problems.join(', ') });
      continue;
    }
    if (email) emails.set(email, r.line);
    rows.push({
      line: r.line,
      client,
      type,
      siret,
      contactNom: get('contactNom') || null,
      email,
      telephone: get('telephone') || null,
      adresse: get('adresse') || null,
      projets: get('projets')
        .split(/[,;|]/)
        .map((p) => p.trim())
        .filter(Boolean),
    });
  }
  return { rows, errors, colonnes, ignorees };
}

/** Rapproche deux noms de client malgré la casse, les accents et la forme juridique (« SAS Horizon » = « Horizon »). */
export function clientKey(nom: string): string {
  return normalizeHeader(nom)
    .replace(/(^|_)(sas|sasu|sarl|eurl|sa|sci|snc|ste|societe|ets|groupe)(_|$)/g, '$1$3')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}
