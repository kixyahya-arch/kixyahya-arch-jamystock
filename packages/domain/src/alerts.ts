/**
 * Alertes de dépassement de forfait (§6.2). Évaluées chaque nuit après l'instantané m².
 */
export type AlertRule = 'RG-AL-01' | 'RG-AL-02' | 'RG-AL-04';

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
