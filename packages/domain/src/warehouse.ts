/**
 * WMS-01 à 03 : génération d'emplacements par motif, import CSV et étiquettes (formats Avery, ZPL Zebra).
 * Pur et sans dépendance : partagé par l'API (création, PDF, ZPL) et le Back-Office (aperçu immédiat).
 */

import type { LocationType } from './surface.js';

export const LOCATION_TYPES: readonly LocationType[] = ['RACK', 'ETAGERE', 'SOL'];
export const LOCATION_STATUSES = ['ACTIF', 'BLOQUE', 'MAINTENANCE'] as const;
export type LocationStatus = (typeof LOCATION_STATUSES)[number];

/** Au-delà, l'assistant demande de découper : une allée de 5 niveaux × 40 cases fait 200 emplacements. */
export const MAX_GENERATED_LOCATIONS = 2000;

/** « 4 », « 1-5 », « 1 à 20 », « 1,3,5-7 ». Renvoie null si la saisie est invalide. */
export function parseRange(input: string | number | null | undefined): number[] | null {
  if (input == null) return null;
  const text = String(input).trim();
  if (!text) return null;
  const out = new Set<number>();
  for (const part of text.split(/[,;]\s*/)) {
    const m = part.trim().match(/^(\d{1,3})(?:\s*(?:-|à|a|\.\.)\s*(\d{1,3}))?$/i);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] != null ? Number(m[2]) : from;
    if (to < from || to - from > 999) return null;
    for (let i = from; i <= to; i++) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

export interface PatternInput {
  depotCode: string;
  zoneCode: string;
  /** Allées (ex. « 4 » ou « 1-3 ») ; vide = emplacements directement dans la zone (sol). */
  allees?: string;
  /** Niveaux (ex. « 1-5 ») ; vide = un seul niveau, non numéroté (sol, étagère simple). */
  niveaux?: string;
  /** Cases ou positions (ex. « 1-20 »). */
  cases: string;
  /** Gabarit du code ; jetons {D} dépôt, {Z} zone, {A} allée sur 2 chiffres, {N} niveau, {C} case sur 2 chiffres. */
  template?: string;
}

export interface GeneratedLocation {
  code: string;
  allee: number | null;
  niveau: number | null;
  case: number;
  /** Libellés du chemin sous la zone, ex. ["Allée 4", "Niveau 1", "Case 12"]. */
  chemin: string[];
}

export const DEFAULT_TEMPLATE_RACK = '{D}-{Z}-{A}-{N}{C}';
export const DEFAULT_TEMPLATE_FLAT = '{D}-{Z}-{A}-{C}';
export const DEFAULT_TEMPLATE_FLOOR = '{D}-{Z}-S{C}';

export function defaultTemplate(p: Pick<PatternInput, 'allees' | 'niveaux'>): string {
  if (!p.allees?.trim()) return DEFAULT_TEMPLATE_FLOOR;
  return p.niveaux?.trim() ? DEFAULT_TEMPLATE_RACK : DEFAULT_TEMPLATE_FLAT;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const CODE_RE = /^[A-Z0-9][A-Z0-9._-]{0,39}$/;

export function normalizeCode(code: string): string {
  return code
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-');
}

export function isValidLocationCode(code: string): boolean {
  return CODE_RE.test(code);
}

export type PatternResult = { ok: true; locations: GeneratedLocation[] } | { ok: false; error: string };

/** Assistant WMS-02 : développe le motif en emplacements nommés (ex. N-B-04-112 = allée 4, niveau 1, case 12). */
export function expandLocationPattern(p: PatternInput): PatternResult {
  const allees = p.allees?.trim() ? parseRange(p.allees) : [null];
  if (!allees) return { ok: false, error: 'Allées : saisissez un numéro ou une plage, par exemple 4 ou 1-3.' };
  const niveaux = p.niveaux?.trim() ? parseRange(p.niveaux) : [null];
  if (!niveaux) return { ok: false, error: 'Niveaux : saisissez une plage, par exemple 1-5.' };
  const cases = parseRange(p.cases);
  if (!cases) return { ok: false, error: 'Cases : saisissez une plage, par exemple 1-20.' };
  const total = allees.length * niveaux.length * cases.length;
  if (total > MAX_GENERATED_LOCATIONS) {
    return { ok: false, error: `${total} emplacements demandés : au plus ${MAX_GENERATED_LOCATIONS} par génération, découpez par allée.` };
  }
  const template = p.template?.trim() || defaultTemplate(p);
  if (!template.includes('{C}')) return { ok: false, error: 'Le gabarit doit contenir {C} (numéro de case).' };
  if (allees[0] !== null && allees.length > 1 && !template.includes('{A}')) return { ok: false, error: 'Plusieurs allées : le gabarit doit contenir {A}.' };
  if (niveaux[0] !== null && niveaux.length > 1 && !template.includes('{N}')) return { ok: false, error: 'Plusieurs niveaux : le gabarit doit contenir {N}.' };

  const depot = normalizeCode(p.depotCode);
  const zone = normalizeCode(p.zoneCode);
  const locations: GeneratedLocation[] = [];
  const seen = new Set<string>();
  for (const a of allees) {
    for (const n of niveaux) {
      for (const c of cases) {
        const code = normalizeCode(
          template
            .replaceAll('{D}', depot)
            .replaceAll('{Z}', zone)
            .replaceAll('{A}', a == null ? '' : pad2(a))
            .replaceAll('{N}', n == null ? '' : String(n))
            .replaceAll('{C}', pad2(c)),
        ).replace(/-{2,}/g, '-');
        if (!isValidLocationCode(code)) return { ok: false, error: `Code « ${code} » invalide : lettres, chiffres, tirets, 40 caractères au plus.` };
        if (seen.has(code)) return { ok: false, error: `Le gabarit produit deux fois le code « ${code} » : ajoutez {A}, {N} ou {C}.` };
        seen.add(code);
        const chemin = [a == null ? null : `Allée ${a}`, n == null ? null : `Niveau ${n}`, a == null && n == null ? `Sol ${c}` : `Case ${c}`].filter(
          (x): x is string => x != null,
        );
        locations.push({ code, allee: a, niveau: n, case: c, chemin });
      }
    }
  }
  return { ok: true, locations };
}

// ---------------------------------------------------------------- import CSV

export interface CsvLocationRow {
  line: number;
  zone: string;
  code: string;
  type: LocationType;
  longueurM: number | null;
  largeurM: number | null;
  hauteurM: number | null;
  surfaceM2: number;
  chargeMaxKg: number | null;
  statut: LocationStatus;
  /** Libellé lisible ajouté au chemin sous la zone ; par défaut le code. */
  libelle: string | null;
}

export interface CsvParseResult {
  rows: CsvLocationRow[];
  errors: { line: number; message: string }[];
}

export const CSV_LOCATION_COLUMNS = ['zone', 'code', 'type', 'longueur_m', 'largeur_m', 'hauteur_m', 'surface_m2', 'charge_max_kg', 'statut', 'libelle'] as const;

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const num = (s: string | undefined): number | null => {
  if (s == null || s === '') return null;
  const n = Number(s.replace(',', '.').replace(/\s/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

const TYPE_ALIASES: Record<string, LocationType> = { RACK: 'RACK', ETAGERE: 'ETAGERE', SOL: 'SOL', SHELF: 'ETAGERE', FLOOR: 'SOL' };
const STATUS_ALIASES: Record<string, LocationStatus> = { ACTIF: 'ACTIF', BLOQUE: 'BLOQUE', MAINTENANCE: 'MAINTENANCE', '': 'ACTIF' };

/**
 * Import CSV (WMS-02) : séparateur « ; » (Excel français) ou « , », première ligne d'en-têtes.
 * Colonnes obligatoires : zone, code. Les autres sont facultatives. Surface par défaut : L × l.
 */
export function parseLocationCsv(text: string): CsvParseResult {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const errors: CsvParseResult['errors'] = [];
  const rows: CsvLocationRow[] = [];
  const headerLine = lines.findIndex((l) => l.trim() !== '');
  if (headerLine < 0) return { rows, errors: [{ line: 1, message: 'Fichier vide.' }] };
  const sep = (lines[headerLine]!.match(/;/g)?.length ?? 0) >= (lines[headerLine]!.match(/,/g)?.length ?? 0) ? ';' : ',';
  const header = splitCsvLine(lines[headerLine]!, sep).map((h) =>
    h
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, ''),
  );
  const col = (name: string) => header.indexOf(name);
  if (col('zone') < 0 || col('code') < 0) return { rows, errors: [{ line: headerLine + 1, message: 'En-têtes « zone » et « code » obligatoires.' }] };
  const seen = new Map<string, number>();
  for (let i = headerLine + 1; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!raw.trim()) continue;
    const line = i + 1;
    const cells = splitCsvLine(raw, sep);
    const get = (name: string) => (col(name) >= 0 ? (cells[col(name)] ?? '') : '');
    const zone = normalizeCode(get('zone'));
    const code = normalizeCode(get('code'));
    const type = TYPE_ALIASES[normalizeCode(get('type') || 'SOL').replace(/-/g, '')];
    const statut = STATUS_ALIASES[normalizeCode(get('statut')).replace(/-/g, '')];
    const [L, l, H, surf, charge] = [num(get('longueur_m')), num(get('largeur_m')), num(get('hauteur_m')), num(get('surface_m2')), num(get('charge_max_kg'))];
    const problems: string[] = [];
    if (!zone) problems.push('zone manquante');
    if (!isValidLocationCode(code)) problems.push(`code « ${get('code')} » invalide`);
    if (!type) problems.push(`type « ${get('type')} » inconnu (RACK, ETAGERE ou SOL)`);
    if (!statut) problems.push(`statut « ${get('statut')} » inconnu (ACTIF, BLOQUE ou MAINTENANCE)`);
    if ([L, l, H, surf, charge].some((x) => Number.isNaN(x))) problems.push('nombre invalide');
    const dup = seen.get(code);
    if (dup) problems.push(`code déjà présent ligne ${dup}`);
    if (problems.length) {
      errors.push({ line, message: problems.join(', ') });
      continue;
    }
    seen.set(code, line);
    rows.push({
      line,
      zone,
      code,
      type: type!,
      longueurM: L,
      largeurM: l,
      hauteurM: H,
      surfaceM2: surf ?? (L != null && l != null ? Math.round(L * l * 100) / 100 : 0),
      chargeMaxKg: charge,
      statut: statut!,
      libelle: get('libelle') || null,
    });
  }
  return { rows, errors };
}

// ---------------------------------------------------------------- étiquettes

export interface AveryFormat {
  id: string;
  nom: string;
  /** Dimensions en millimètres. */
  largeur: number;
  hauteur: number;
  colonnes: number;
  lignes: number;
  margeHaut: number;
  margeGauche: number;
  pasH: number;
  pasV: number;
}

/** Planches A4 courantes ; d'autres formats s'ajoutent ici sans toucher au rendu. */
export const AVERY_FORMATS: AveryFormat[] = [
  { id: 'L7160', nom: 'Avery L7160 · 21 étiquettes 63,5 × 38,1 mm', largeur: 63.5, hauteur: 38.1, colonnes: 3, lignes: 7, margeHaut: 15.15, margeGauche: 7.2, pasH: 66, pasV: 38.1 },
  { id: 'L7163', nom: 'Avery L7163 · 14 étiquettes 99,1 × 38,1 mm', largeur: 99.1, hauteur: 38.1, colonnes: 2, lignes: 7, margeHaut: 15.15, margeGauche: 4.65, pasH: 101.6, pasV: 38.1 },
  { id: 'L7165', nom: 'Avery L7165 · 8 étiquettes 99,1 × 67,7 mm', largeur: 99.1, hauteur: 67.7, colonnes: 2, lignes: 4, margeHaut: 13.1, margeGauche: 4.65, pasH: 101.6, pasV: 67.7 },
  { id: 'L7651', nom: 'Avery L7651 · 65 étiquettes 38,1 × 21,2 mm', largeur: 38.1, hauteur: 21.2, colonnes: 5, lignes: 13, margeHaut: 10.7, margeGauche: 4.75, pasH: 40.6, pasV: 21.2 },
  { id: '3475', nom: 'Avery 3475 · 24 étiquettes 70 × 36 mm', largeur: 70, hauteur: 36, colonnes: 3, lignes: 8, margeHaut: 4.5, margeGauche: 0, pasH: 70, pasV: 36 },
];

export const ZEBRA_FORMATS = [
  { id: 'ZEBRA_50x25', nom: 'Zebra 50 × 25 mm', largeur: 50, hauteur: 25 },
  { id: 'ZEBRA_100x50', nom: 'Zebra 100 × 50 mm', largeur: 100, hauteur: 50 },
] as const;
export type ZebraFormatId = (typeof ZEBRA_FORMATS)[number]['id'];

export interface LabelContent {
  /** Données du QR (URL q.jamystock.fr/…). */
  qr: string;
  /** Texte principal lisible : code d'emplacement ou QR de l'article. */
  titre: string;
  /** Ligne secondaire : chemin ou libellé de l'article. */
  sousTitre?: string | null;
  /** Nom du dépôt (exigé par WMS-03). */
  depot: string;
}

/** Position de chaque étiquette sur la planche (mm depuis le coin haut-gauche), en sautant les `skip` premières déjà utilisées. */
export function averySlots(format: AveryFormat, count: number, skip = 0): { page: number; x: number; y: number }[] {
  const perPage = format.colonnes * format.lignes;
  const out: { page: number; x: number; y: number }[] = [];
  for (let i = 0; i < count; i++) {
    const slot = i + skip;
    const page = Math.floor(slot / perPage);
    const k = slot % perPage;
    const row = Math.floor(k / format.colonnes);
    const colIdx = k % format.colonnes;
    out.push({ page, x: format.margeGauche + colIdx * format.pasH, y: format.margeHaut + row * format.pasV });
  }
  return out;
}

/** ZPL n'accepte que l'ASCII imprimable hors ^ et ~ (caractères de commande) dans ^FD. */
export function zplText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’‘]/g, "'")
    .replace(/[«»“”]/g, '"')
    .replace(/[–—·]/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[\^~]/g, '-');
}

const ellipsis = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}.` : s);

/**
 * Étiquette ZPL II pour imprimante thermique 203 dpi (8 points/mm) : QR à gauche, code, chemin et dépôt à droite.
 * Une étiquette = un bloc ^XA…^XZ ; on concatène pour une impression en série.
 */
export function zplLabel(label: LabelContent, format: ZebraFormatId): string {
  const big = format === 'ZEBRA_100x50';
  const w = big ? 800 : 400;
  const h = big ? 400 : 200;
  const mag = big ? 8 : 4; // taille du module QR en points
  const qrX = big ? 24 : 12;
  const qrY = big ? 30 : 14;
  const textX = big ? 340 : 176;
  const textW = w - textX - (big ? 20 : 10);
  const chars = (fontW: number) => Math.floor(textW / fontW);
  const titleH = big ? 56 : 30;
  const subH = big ? 28 : 18;
  return [
    '^XA',
    '^CI28',
    `^PW${w}`,
    `^LL${h}`,
    '^LH0,0',
    `^FO${qrX},${qrY}^BQN,2,${mag}^FDMA,${zplText(label.qr)}^FS`,
    `^FO${textX},${big ? 40 : 18}^A0N,${titleH},${Math.round(titleH * 0.85)}^FD${ellipsis(zplText(label.titre), chars(Math.round(titleH * 0.6)))}^FS`,
    label.sousTitre
      ? `^FO${textX},${big ? 120 : 62}^FB${textW},${big ? 4 : 3},4,L^A0N,${subH},${Math.round(subH * 0.85)}^FD${ellipsis(zplText(label.sousTitre), big ? 120 : 60)}^FS`
      : '',
    `^FO${textX},${h - (big ? 56 : 28)}^A0N,${big ? 30 : 16},${big ? 26 : 13}^FD${ellipsis(zplText(label.depot), chars(big ? 15 : 9))}^FS`,
    '^PQ1',
    '^XZ',
  ]
    .filter(Boolean)
    .join('\n');
}

export function zplLabels(labels: LabelContent[], format: ZebraFormatId): string {
  return labels.map((l) => zplLabel(l, format)).join('\n') + '\n';
}

// ---------------------------------------------------------------- corrections de stock (WMS-06)

export const STOCK_CORRECTIONS = ['DEPLACER', 'PERDU', 'ENDOMMAGE', 'RETROUVE', 'DETRUIT', 'RETIRER_UM', 'FUSIONNER_UM'] as const;
export type StockCorrection = (typeof STOCK_CORRECTIONS)[number];

export const STOCK_CORRECTION_LABEL: Record<StockCorrection, string> = {
  DEPLACER: 'Déplacer',
  PERDU: 'Déclarer perdu',
  ENDOMMAGE: 'Déclarer endommagé',
  RETROUVE: 'Retrouvé',
  DETRUIT: 'Déclarer détruit',
  RETIRER_UM: 'Sortir de l’unité (scinder)',
  FUSIONNER_UM: 'Fusionner les unités',
};
