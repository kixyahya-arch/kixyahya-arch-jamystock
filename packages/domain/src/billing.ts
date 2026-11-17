/**
 * Moteur de facturation mensuelle (§6.1, RG-M2-05 et RG-M2-06).
 * Tous les montants sont en centimes d'euro (entiers) pour éviter les erreurs d'arrondi.
 */

export type MonthlySurfaceMode = 'MOYENNE' | 'PIC';

/** Arrondi au 0,5 m² supérieur (RG-M2-05). */
export function roundUpHalf(m2: number): number {
  // on neutralise le bruit flottant (131.00000001 ne doit pas donner 131.5)
  const v = Math.round(m2 * 1000) / 1000;
  return Math.ceil(v * 2) / 2;
}

/**
 * Surface facturée du mois à partir des instantanés quotidiens.
 * Les jours hors contrat ne doivent pas être passés (le prorata est géré séparément).
 */
export function monthlyBilledSurface(dailyM2: number[], mode: MonthlySurfaceMode = 'MOYENNE'): number {
  if (dailyM2.length === 0) return 0;
  const raw = mode === 'PIC' ? Math.max(...dailyM2) : dailyM2.reduce((s, v) => s + v, 0) / dailyM2.length;
  return roundUpHalf(raw);
}

export interface ServiceUsage {
  /** code de prestation (ex. LIVRAISON_ZONE_1, MANUTENTION_HEURE, ANNULATION_TARDIVE) */
  code: string;
  label: string;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  vatRate: number;
  /** id de la mission ou de l'événement source (LigneFacture.source_id) */
  sourceId?: string;
}

export interface ContractTerms {
  includedM2: number;
  /** prix mensuel de l'abonnement HT, en centimes (ex. 180000 pour 1 800 €) */
  monthlyPriceCents: number;
  overagePricePerM2Cents: number;
  /** quantités incluses au forfait par code de prestation (ex. { LIVRAISON: 2 }) */
  includedServices: Record<string, number>;
  vatRate: number;
  surfaceMode: MonthlySurfaceMode;
}

export interface InvoiceLine {
  type: 'ABONNEMENT' | 'DEPASSEMENT_M2' | 'PRESTATION';
  label: string;
  quantity: number;
  unit: string;
  unitPriceCents: number;
  vatRate: number;
  totalHtCents: number;
  sourceId?: string;
}

export interface InvoiceDraft {
  billedM2: number;
  lines: InvoiceLine[];
  totalHtCents: number;
  totalVatCents: number;
  totalTtcCents: number;
}

export interface MonthlyInvoiceInput {
  terms: ContractTerms;
  /** surfaces quotidiennes des jours couverts par le contrat dans le mois */
  dailyM2: number[];
  /** nombre de jours du mois civil */
  daysInMonth: number;
  services: ServiceUsage[];
  /**
   * jours du mois couverts par le contrat (prorata de l'abonnement). Par défaut : nombre d'instantanés.
   * À passer quand des instantanés manquent : la moyenne se fait sur ceux disponibles, le prorata sur le contrat.
   */
  coveredDays?: number;
  /** code de prestation → famille utilisée pour le quota inclus (ex. LIVRAISON_ZONE_1 → LIVRAISON) */
  serviceFamily?: (code: string) => string;
}

function lineTotal(quantity: number, unitPriceCents: number): number {
  return Math.round(quantity * unitPriceCents);
}

const defaultFamily = (code: string): string => code.split('_')[0] ?? code;

export function computeMonthlyInvoice(input: MonthlyInvoiceInput): InvoiceDraft {
  const { terms, dailyM2, daysInMonth } = input;
  const lines: InvoiceLine[] = [];
  const coveredDays = input.coveredDays ?? dailyM2.length;
  if (coveredDays > daysInMonth) throw new Error('Plus de jours couverts que de jours dans le mois');

  const prorata = coveredDays / daysInMonth;
  const billedM2 = monthlyBilledSurface(dailyM2, terms.surfaceMode);

  if (coveredDays > 0) {
    const isFull = coveredDays === daysInMonth;
    lines.push({
      type: 'ABONNEMENT',
      label: isFull
        ? `Forfait ${terms.includedM2} m²`
        : `Forfait ${terms.includedM2} m² (prorata ${coveredDays}/${daysInMonth} jours)`,
      quantity: isFull ? 1 : Math.round(prorata * 10000) / 10000,
      unit: 'mois',
      unitPriceCents: terms.monthlyPriceCents,
      vatRate: terms.vatRate,
      totalHtCents: lineTotal(prorata, terms.monthlyPriceCents),
    });

    const overageM2 = Math.max(0, billedM2 - terms.includedM2);
    if (overageM2 > 0) {
      // le dépassement est lui aussi proratisé pour un mois incomplet
      const qty = isFull ? overageM2 : Math.round(overageM2 * prorata * 100) / 100;
      lines.push({
        type: 'DEPASSEMENT_M2',
        label: `Dépassement de surface (${billedM2} m² facturés, ${terms.includedM2} m² inclus)`,
        quantity: qty,
        unit: 'm²',
        unitPriceCents: terms.overagePricePerM2Cents,
        vatRate: terms.vatRate,
        totalHtCents: lineTotal(qty, terms.overagePricePerM2Cents),
      });
    }
  }

  // prestations : on consomme d'abord le quota inclus, par famille, dans l'ordre d'arrivée
  const family = input.serviceFamily ?? defaultFamily;
  const remainingQuota = new Map(Object.entries(terms.includedServices));
  for (const s of input.services) {
    const fam = family(s.code);
    const left = remainingQuota.get(fam) ?? 0;
    const included = Math.min(left, s.quantity);
    if (included > 0) remainingQuota.set(fam, left - included);
    const billable = s.quantity - included;
    if (billable <= 0) continue;
    lines.push({
      type: 'PRESTATION',
      label: included > 0 ? `${s.label} (au-delà du forfait)` : s.label,
      quantity: billable,
      unit: s.unit,
      unitPriceCents: s.unitPriceCents,
      vatRate: s.vatRate,
      totalHtCents: lineTotal(billable, s.unitPriceCents),
      sourceId: s.sourceId,
    });
  }

  return { billedM2, lines, ...totals(lines) };
}

/** TVA calculée par taux puis arrondie (une ligne de TVA par taux sur la facture). */
export function totals(lines: Pick<InvoiceLine, 'totalHtCents' | 'vatRate'>[]): {
  totalHtCents: number;
  totalVatCents: number;
  totalTtcCents: number;
} {
  const byRate = new Map<number, number>();
  let ht = 0;
  for (const l of lines) {
    ht += l.totalHtCents;
    byRate.set(l.vatRate, (byRate.get(l.vatRate) ?? 0) + l.totalHtCents);
  }
  let vat = 0;
  for (const [rate, base] of byRate) vat += Math.round((base * rate) / 100);
  return { totalHtCents: ht, totalVatCents: vat, totalTtcCents: ht + vat };
}

/** Avoir (FAC-04) : lignes négatives, partiel ou total. */
export function creditNoteLines(lines: InvoiceLine[], ratio = 1): InvoiceLine[] {
  if (ratio <= 0 || ratio > 1) throw new Error("Le ratio d'un avoir doit être dans ]0 ; 1]");
  return lines.map((l) => ({
    ...l,
    label: `Avoir : ${l.label}`,
    quantity: ratio === 1 ? l.quantity : Math.round(l.quantity * ratio * 10000) / 10000,
    unitPriceCents: -l.unitPriceCents,
    totalHtCents: -Math.round(l.totalHtCents * ratio),
  }));
}

/**
 * Avoir partiel d'un montant HT donné (FAC-04) : une ligne par taux de TVA de la facture d'origine,
 * au prorata de la base de chaque taux, la dernière absorbant l'arrondi pour tomber juste.
 */
export function partialCreditLines(origin: Pick<InvoiceLine, 'totalHtCents' | 'vatRate'>[], amountHtCents: number, label: string): InvoiceLine[] {
  const byRate = new Map<number, number>();
  for (const l of origin) byRate.set(l.vatRate, (byRate.get(l.vatRate) ?? 0) + l.totalHtCents);
  const base = [...byRate.values()].reduce((s, v) => s + v, 0);
  if (base <= 0) throw new Error('Facture d’origine sans montant');
  const rates = [...byRate.entries()].filter(([, v]) => v > 0);
  let left = amountHtCents;
  return rates.map(([rate, v], i) => {
    const part = i === rates.length - 1 ? left : Math.round((amountHtCents * v) / base);
    left -= part;
    return {
      type: 'PRESTATION' as const,
      label: rates.length > 1 ? `${label} (TVA ${rate} %)` : label,
      quantity: 1,
      unit: 'forfait',
      unitPriceCents: -part,
      vatRate: rate,
      totalHtCents: -part,
    };
  });
}

/** Numérotation chronologique continue (FAC-03) : préfixe-année-séquence. */
export function formatDocumentNumber(prefix: string, year: number, seq: number): string {
  return `${prefix}-${year}-${String(seq).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Calendrier de facturation (FAC-02, FAC-03) : tout est exprimé en jours calendaires à Paris.

/** Date (AAAA-MM-JJ), heure et minute à Paris d'un instant. */
export function parisClock(at: Date): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const v = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${v('year')}-${v('month')}-${v('day')}`, hour: Number(v('hour')), minute: Number(v('minute')) };
}

/** Décale une date calendaire AAAA-MM-JJ de n jours. */
export function addIsoDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Nombre de jours de from à to inclus (0 si to < from). */
export function daysBetweenInclusive(from: string, to: string): number {
  const ms = Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`);
  return ms < 0 ? 0 : Math.round(ms / 86_400_000) + 1;
}

/** Mois civil AAAA-MM : premier et dernier jour, nombre de jours. */
export function monthBounds(month: string): { start: string; end: string; days: number } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`Mois invalide : ${month}`);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(days).padStart(2, '0')}`, days };
}

/** Mois civil qui précède celui de la date donnée. */
export function previousMonth(date: string): string {
  return addIsoDays(`${date.slice(0, 7)}-01`, -1).slice(0, 7);
}

/**
 * Intersection d'un contrat (date_debut, date_fin incluse ou ouverte) avec un mois : jours facturables
 * (RG-M2-06, premier et dernier mois au prorata). null si le contrat ne couvre aucun jour du mois.
 */
export function contractPeriodInMonth(month: string, start: string, end: string | null): { from: string; to: string; days: number } | null {
  const b = monthBounds(month);
  const from = start > b.start ? start : b.start;
  const to = end && end < b.end ? end : b.end;
  const days = daysBetweenInclusive(from, to);
  return days > 0 ? { from, to, days } : null;
}

/** Brouillons créés le 1er du mois à 2 h (Paris), émis automatiquement à J+2 sauf blocage (FAC-03). */
export const DRAFT_HOUR = 2;
export const AUTO_ISSUE_DELAY_DAYS = 2;

/** Les brouillons du mois précédent sont dus dès le 1er à 2 h (rattrapage si le service dormait). */
export function draftsDue(at: Date): string | null {
  const c = parisClock(at);
  if (c.date.endsWith('-01') && c.hour < DRAFT_HOUR) return null;
  return previousMonth(c.date);
}

/**
 * Avoir partiel ou total (FAC-04) : part de la facture d'origine à annuler, d'après le montant HT demandé
 * et ce qui a déjà été crédité. Lève une erreur si le montant dépasse le solde créditable.
 */
export function creditRatio(invoiceHtCents: number, alreadyCreditedHtCents: number, requestedHtCents?: number): number {
  const left = invoiceHtCents - alreadyCreditedHtCents;
  if (left <= 0) throw new Error('Cette facture est déjà entièrement créditée');
  const amount = requestedHtCents ?? left;
  if (amount <= 0) throw new Error("Le montant d'un avoir doit être positif");
  if (amount > left) throw new Error(`Le montant dépasse le solde créditable (${(left / 100).toFixed(2)} € HT)`);
  return amount / invoiceHtCents;
}

/** Montant en euros au format français, sans espace insécable fine (non imprimable dans les polices PDF standard). */
export function formatEuros(cents: number): string {
  const s = (cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${s.replace(/[\u202f\u00a0]/g, ' ')} €`;
}
