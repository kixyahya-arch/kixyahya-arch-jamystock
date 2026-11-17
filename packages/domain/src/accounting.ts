/**
 * FAC-05 (relances des impayés) et FAC-06 (export des écritures vers l'outil comptable).
 * Fonctions pures : la base fournit les factures, avoirs et paiements, le domaine produit les relances dues
 * et les lignes du Fichier des Écritures Comptables (FEC, article A47 A-1 du LPF).
 */

/** Paliers de relance après l'échéance : J+7, J+15, J+30. */
export const DUNNING_STEPS = [7, 15, 30] as const;

const dayMs = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs);

/** Jours de retard au `today` (0 si non échue). */
export function daysLate(echeance: string | null, today: string): number {
  if (!echeance) return 0;
  return Math.max(0, daysBetween(echeance, today));
}

/**
 * Niveau de relance dû (1, 2 ou 3) au vu du retard, ou 0. Un service arrêté plusieurs jours n'envoie que le
 * palier le plus récent : on ne rattrape pas trois relances d'un coup.
 */
export function dunningLevelDue(echeance: string | null, today: string, alreadySent: number): number {
  const late = daysLate(echeance, today);
  let level = 0;
  DUNNING_STEPS.forEach((d, i) => {
    if (late >= d) level = i + 1;
  });
  return level > alreadySent ? level : 0;
}

// ===========================================================================================================
// FEC
// ===========================================================================================================

export interface AccountingPlan {
  ventes: string; // 706000 Prestations de services
  tva: string; // 445710 TVA collectée
  clients: string; // 411000 Clients
  banque: string; // 512000 Banque
  journalVentes: string;
  journalBanque: string;
}

export const DEFAULT_PLAN: AccountingPlan = { ventes: '706000', tva: '445710', clients: '411000', banque: '512000', journalVentes: 'VE', journalBanque: 'BQ' };

export interface AccountingInvoice {
  numero: string;
  type: 'FACTURE' | 'AVOIR';
  emiseLe: string; // AAAA-MM-JJ
  client: { code: string; nom: string };
  /** Montants signés tels qu'en base (un avoir est négatif). */
  lignes: { tauxTva: number; totalHtCents: number }[];
  totalTtcCents: number;
}

export interface AccountingPayment {
  reference: string;
  date: string;
  factureNumero: string;
  client: { code: string; nom: string };
  montantCents: number;
  moyen: string;
}

export interface FecLine {
  JournalCode: string;
  JournalLib: string;
  EcritureNum: string;
  EcritureDate: string;
  CompteNum: string;
  CompteLib: string;
  CompAuxNum: string;
  CompAuxLib: string;
  PieceRef: string;
  PieceDate: string;
  EcritureLib: string;
  Debit: number; // centimes
  Credit: number; // centimes
  EcritureLet: string;
  DateLet: string;
  ValidDate: string;
  Montantdevise: string;
  Idevise: string;
}

export const FEC_COLUMNS: (keyof FecLine)[] = [
  'JournalCode', 'JournalLib', 'EcritureNum', 'EcritureDate', 'CompteNum', 'CompteLib', 'CompAuxNum', 'CompAuxLib', 'PieceRef',
  'PieceDate', 'EcritureLib', 'Debit', 'Credit', 'EcritureLet', 'DateLet', 'ValidDate', 'Montantdevise', 'Idevise',
];

const ymd = (iso: string) => iso.slice(0, 10).replace(/-/g, '');

/**
 * Écritures d'une période : une écriture par facture ou avoir au journal des ventes (411 au débit, 706 et 4457 au
 * crédit, par taux de TVA ; sens inversé pour un avoir), une par paiement au journal de banque (512 / 411).
 * Chaque écriture est équilibrée ; les numéros se suivent par journal.
 */
export function fecEntries(invoices: AccountingInvoice[], payments: AccountingPayment[], plan: AccountingPlan = DEFAULT_PLAN): FecLine[] {
  const out: FecLine[] = [];
  const base = (journal: 'VE' | 'BQ', num: number, date: string, piece: string, lib: string) => ({
    JournalCode: journal === 'VE' ? plan.journalVentes : plan.journalBanque,
    JournalLib: journal === 'VE' ? 'Ventes' : 'Banque',
    EcritureNum: `${journal === 'VE' ? plan.journalVentes : plan.journalBanque}${String(num).padStart(6, '0')}`,
    EcritureDate: ymd(date),
    PieceRef: piece,
    PieceDate: ymd(date),
    EcritureLib: lib,
    EcritureLet: '',
    DateLet: '',
    ValidDate: ymd(date),
    Montantdevise: '',
    Idevise: '',
  });
  const amount = (cents: number) => (cents >= 0 ? { Debit: cents, Credit: 0 } : { Debit: 0, Credit: -cents });

  [...invoices]
    .sort((a, b) => a.emiseLe.localeCompare(b.emiseLe) || a.numero.localeCompare(b.numero))
    .forEach((f, i) => {
      const head = base('VE', i + 1, f.emiseLe, f.numero, `${f.type === 'AVOIR' ? 'Avoir' : 'Facture'} ${f.numero} ${f.client.nom}`);
      // regroupement par taux : un compte de produit et un compte de TVA par taux
      const byRate = new Map<number, number>();
      for (const l of f.lignes) byRate.set(l.tauxTva, (byRate.get(l.tauxTva) ?? 0) + l.totalHtCents);
      const vat = [...byRate].map(([rate, ht]) => ({ rate, ht, tva: Math.round((ht * rate) / 100) }));
      // l'arrondi de la TVA par taux peut différer d'un centime du total TTC enregistré : on l'absorbe sur la TVA
      const gap = f.totalTtcCents - vat.reduce((s, v) => s + v.ht + v.tva, 0);
      if (vat.length && gap !== 0 && Math.abs(gap) <= vat.length) vat[0]!.tva += gap;
      out.push({ ...head, CompteNum: plan.clients, CompteLib: 'Clients', CompAuxNum: f.client.code, CompAuxLib: f.client.nom, ...amount(f.totalTtcCents) });
      for (const v of vat) {
        out.push({ ...head, CompteNum: plan.ventes, CompteLib: `Prestations de services${vat.length > 1 ? ` ${v.rate} %` : ''}`, CompAuxNum: '', CompAuxLib: '', ...amount(-v.ht) });
        if (v.tva !== 0) out.push({ ...head, CompteNum: plan.tva, CompteLib: `TVA collectée ${v.rate} %`, CompAuxNum: '', CompAuxLib: '', ...amount(-v.tva) });
      }
    });

  [...payments]
    .sort((a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference))
    .forEach((p, i) => {
      const head = base('BQ', i + 1, p.date, p.reference, `Règlement ${p.factureNumero} ${p.client.nom} (${p.moyen})`);
      out.push({ ...head, CompteNum: plan.banque, CompteLib: 'Banque', CompAuxNum: '', CompAuxLib: '', ...amount(p.montantCents) });
      out.push({ ...head, CompteNum: plan.clients, CompteLib: 'Clients', CompAuxNum: p.client.code, CompAuxLib: p.client.nom, ...amount(-p.montantCents), EcritureLet: '', DateLet: '' });
    });
  return out;
}

/** Montant au format FEC : virgule décimale, sans séparateur de milliers. */
const fecAmount = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

/** Fichier FEC : tabulations, en-tête normalisé (le nom attendu est SIRENFECAAAAMMJJ.txt). */
export function fecFile(lines: FecLine[], separator: '\t' | ';' = '\t'): string {
  const clean = (v: string) => v.replace(/[\t\r\n;|]/g, ' ');
  const rows = lines.map((l) => FEC_COLUMNS.map((c) => (c === 'Debit' || c === 'Credit' ? fecAmount(l[c]) : clean(String(l[c])))).join(separator));
  return [FEC_COLUMNS.join(separator), ...rows].join('\r\n') + '\r\n';
}

/** Code auxiliaire d'un client : stable, court, lisible (C + 8 premiers caractères du SIREN ou de l'identifiant). */
export function clientAccountCode(c: { siret: string | null; id: string }): string {
  return `C${(c.siret ? c.siret.slice(0, 9) : c.id.replace(/-/g, '').slice(-8)).toUpperCase()}`;
}
