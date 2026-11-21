import { parisClock } from './billing.js';

/**
 * Alertes de dépassement de forfait (§6.2). RG-AL-01, 02 et 04 sont évaluées chaque matin sur les instantanés m²,
 * RG-AL-03 au moment de demander une collecte, RG-AL-05 chaque trimestre.
 */
export type AlertRule = 'RG-AL-01' | 'RG-AL-02' | 'RG-AL-03' | 'RG-AL-04' | 'RG-AL-05';

export interface AlertSettings {
  preAlertRatio: number; // 0,9
  overageConsecutiveDays: number; // 3
  underUseRatio: number; // 0,6
  underUseDays: number; // 60
  antiSpamDays: number; // 7
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  preAlertRatio: 0.9,
  overageConsecutiveDays: 3,
  underUseRatio: 0.6,
  underUseDays: 60,
  antiSpamDays: 7,
};

export interface AlertEvaluationInput {
  includedM2: number;
  /** surfaces quotidiennes, la plus récente en dernier */
  history: number[];
  /** date ISO du dernier envoi de chaque règle */
  lastSentAt: Partial<Record<AlertRule, string>>;
  today: string;
  settings?: Partial<AlertSettings>;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400_000);
}

function tail(values: number[], n: number): number[] | null {
  return values.length >= n ? values.slice(values.length - n) : null;
}

export function evaluateAlerts(input: AlertEvaluationInput): AlertRule[] {
  const s = { ...DEFAULT_ALERT_SETTINGS, ...input.settings };
  const { includedM2, history } = input;
  if (includedM2 <= 0 || history.length === 0) return [];
  const current = history[history.length - 1]!;
  const fired: AlertRule[] = [];

  const overDays = tail(history, s.overageConsecutiveDays);
  if (overDays && overDays.every((v) => v > includedM2)) {
    fired.push('RG-AL-02');
  } else if (current >= includedM2 * s.preAlertRatio) {
    fired.push('RG-AL-01');
  }

  const underDays = tail(history, s.underUseDays);
  if (underDays && underDays.every((v) => v < includedM2 * s.underUseRatio)) fired.push('RG-AL-04');

  // anti-spam : une alerte identique au plus une fois tous les 7 jours
  return fired.filter((rule) => {
    const last = input.lastSentAt[rule];
    return !last || daysBetween(last, input.today) >= s.antiSpamDays;
  });
}

/** Seuils de couleur de la jauge ADM-01. */
export function gaugeLevel(usedM2: number, includedM2: number): 'OK' | 'ATTENTION' | 'DEPASSEMENT' {
  if (includedM2 <= 0) return 'OK';
  const r = usedM2 / includedM2;
  if (r > 1) return 'DEPASSEMENT';
  if (r >= DEFAULT_ALERT_SETTINGS.preAlertRatio) return 'ATTENTION';
  return 'OK';
}

/**
 * Hauteur utile moyenne retenue pour passer d'un volume estimé (m³) à une surface au sol (m²) quand le client ne
 * détaille pas ses objets : meubles et cartons rangés au sol, sans gerbage. Hypothèse prudente, documentée dans
 * docs/points-ouverts.md ; l'assistant par type d'objet donne directement l'emprise au sol.
 */
export const COLLECTION_HEIGHT_M = 1.2;

export function floorFromVolume(volumeM3: number, heightM = COLLECTION_HEIGHT_M): number {
  if (!(volumeM3 > 0)) return 0;
  return Math.round((volumeM3 / heightM) * 10) / 10;
}

export interface CollectionForecast {
  m2Occupes: number;
  m2EnCours: number;
  m2Ajoutes: number;
  m2Prevus: number;
  m2Inclus: number;
  niveau: 'OK' | 'ATTENTION' | 'DEPASSEMENT';
  depasse: boolean;
  m2Depassement: number;
}

/** RG-AL-03 : surface après la collecte demandée (et les collectes déjà en cours), face aux m² inclus. */
export function forecastCollection(input: { occupiedM2: number; pendingM2: number; addedM2: number; includedM2: number }): CollectionForecast {
  const r = (v: number) => Math.round(v * 10) / 10;
  const prevus = r(input.occupiedM2 + input.pendingM2 + input.addedM2);
  const over = r(Math.max(0, prevus - input.includedM2));
  return {
    m2Occupes: r(input.occupiedM2),
    m2EnCours: r(input.pendingM2),
    m2Ajoutes: r(input.addedM2),
    m2Prevus: prevus,
    m2Inclus: input.includedM2,
    niveau: gaugeLevel(prevus, input.includedM2),
    depasse: input.includedM2 > 0 && over > 0,
    m2Depassement: over,
  };
}

/** RG-AL-05 : un bien est dormant après 12 mois sans mouvement (date d'entrée à défaut). */
export const DORMANT_MONTHS = 12;

export function dormantSince(at: Date, months = DORMANT_MONTHS): Date {
  const d = new Date(at);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

/** Trimestre civil dont le rapport des biens dormants est dû (le 1er janvier, avril, juillet, octobre et après), ex. « 2027-T1 ». */
export function dormantReportQuarter(at: Date): string {
  const [y, m] = parisClock(at).date.split('-').map(Number) as [number, number];
  return `${y}-T${Math.floor((m - 1) / 3) + 1}`;
}
