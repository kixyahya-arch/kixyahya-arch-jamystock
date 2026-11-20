import { api, NetworkError } from './api';

/**
 * FLX-05 / SUI-02 : position du terminal envoyée pendant un trajet (de « En route » à « Arrivé »),
 * et seulement pendant ce trajet (RGPD). Un point toutes les 15 s au plus, envoyés par paquets toutes les 30 s ;
 * hors réseau, les derniers points attendent (2 minutes d'historique au plus suffisent à la carte).
 */
const KEY = 'jamystock.suivi';
const MIN_GAP_MS = 15_000;
const SEND_EVERY_MS = 30_000;
const MAX_BUFFER = 120;
/** Le départ part par la file d'actions : le serveur peut l'apprendre un peu après les premières positions. */
const GRACE_MS = 3 * 60_000;

interface Point {
  lat: number;
  lng: number;
  precision?: number;
  vitesseKmh?: number;
  at: string;
}

let watchId: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let buffer: Point[] = [];
let lastAt = 0;
let startedAt = 0;

const stored = (): { missionId: string; since: number } | null => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
};

export function trackingMission(): string | null {
  return stored()?.missionId ?? null;
}

export function startTracking(missionId: string) {
  const since = stored()?.missionId === missionId ? stored()!.since : Date.now();
  try {
    localStorage.setItem(KEY, JSON.stringify({ missionId, since }));
  } catch {
    /* stockage indisponible : le suivi tient jusqu'au rechargement */
  }
  begin(since);
}

/** Arrêt du suivi : à l'arrivée, à la signature, ou quand le serveur ne voit plus de trajet en cours. */
export function stopTracking(missionId?: string) {
  if (missionId && stored() && stored()!.missionId !== missionId) return;
  void send();
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* rien */
  }
  if (watchId !== null) navigator.geolocation?.clearWatch(watchId);
  if (timer) clearInterval(timer);
  watchId = null;
  timer = null;
}

/** Au lancement de l'appli : reprendre un trajet commencé avant un rechargement. */
export function resumeTracking() {
  const s = stored();
  if (s) begin(s.since);
}

function begin(since: number) {
  startedAt = since;
  if (watchId !== null || typeof navigator === 'undefined' || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(
    (p) => {
      const t = p.timestamp || Date.now();
      if (t - lastAt < MIN_GAP_MS) return;
      lastAt = t;
      buffer.push({
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        precision: Math.min(100000, Math.round(p.coords.accuracy)),
        vitesseKmh: p.coords.speed != null && p.coords.speed >= 0 ? Math.min(300, Math.round(p.coords.speed * 3.6)) : undefined,
        at: new Date(t).toISOString(),
      });
      if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);
      if (buffer.length === 1) void send();
    },
    () => {
      /* GPS refusé ou indisponible : la carte le signalera (« aucune position reçue ») */
    },
    { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
  );
  timer = setInterval(() => void send(), SEND_EVERY_MS);
}

async function send() {
  if (!buffer.length || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
  const batch = buffer.splice(0, MAX_BUFFER);
  try {
    const r = await api<{ acceptees: number; actif: boolean }>('/field/positions', { method: 'POST', body: JSON.stringify({ positions: batch }) });
    if (!r.actif && Date.now() - startedAt > GRACE_MS) stopTracking();
  } catch (e) {
    // hors réseau : on garde les points les plus récents pour le prochain envoi
    if (e instanceof NetworkError) buffer = [...batch, ...buffer].slice(-MAX_BUFFER);
  }
}
