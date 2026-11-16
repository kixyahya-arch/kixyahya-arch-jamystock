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
  const coveredDays = dailyM2.length;
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
    totalHtCents: -Math.round(l.totalHtCents * ratio),
  }));
}

/** Numérotation chronologique continue (FAC-03) : préfixe-année-séquence. */
export function formatDocumentNumber(prefix: string, year: number, seq: number): string {
  return `${prefix}-${year}-${String(seq).padStart(6, '0')}`;
}
