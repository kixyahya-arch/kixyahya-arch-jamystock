import { useCallback, useEffect, useState } from 'react';
import { get } from '../lib/api';
import { MISSION_STATUS, timeFr } from '../lib/labels';
import { Banner, PlanningTabs, StatusPill } from '../components/ui';
import { LiveMap, type MapPoint } from '../components/LiveMap';

interface Stop {
  missionId: string;
  ordre: number | null;
  type: 'LIVRAISON' | 'COLLECTE';
  statut: string;
  numero: string | null;
  client: string | null;
  adresse: string | null;
  geo: { lat: number; lng: number } | null;
  creneau: string | null;
  arriveLe: string | null;
  tournee: string | null;
}
interface Driver {
  id: string;
  nom: string;
  telephone: string | null;
  position: { lat: number; lng: number; at: string; fraiche: boolean } | null;
  enCours: { missionId: string; numero: string | null; client: string | null; adresse: string | null; type: string; etape: 'EN_ROUTE' | 'ARRIVE'; eta: string | null } | null;
  tournee: string | null;
  faits: number;
  total: number;
  arrets: Stop[];
}
interface FleetData {
  date: string;
  maintenant: string;
  tuiles: string;
  depots: { id: string; nom: string; lat: number; lng: number }[];
  chauffeurs: Driver[];
}

const REFRESH_MS = 30_000;
const initials = (n: string) =>
  n
    .split(/\s+/)
    .map((x) => x[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
const ago = (iso: string, now: string) => {
  const m = Math.max(0, Math.round((Date.parse(now) - Date.parse(iso)) / 60_000));
  return m < 1 ? 'à l’instant' : m < 60 ? `il y a ${m} min` : `il y a ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
};

/**
 * FLX-05 : position des chauffeurs et avancement des missions, rafraîchis toutes les 30 s.
 * Une position n'est connue que pendant une mission en cours (RGPD) ; au-delà de 10 minutes sans nouvelle,
 * elle est signalée comme ancienne.
 */
export function FleetMap() {
  const [d, setD] = useState<FleetData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  const load = useCallback(() => {
    get<FleetData>('/bo/flux/carte')
      .then((r) => {
        setD(r);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const shown = d?.chauffeurs.filter((c) => !focus || c.id === focus) ?? [];
  const points: MapPoint[] = d
    ? [
        ...d.depots.map((x) => ({ id: `d-${x.id}`, lat: x.lat, lng: x.lng, kind: 'depot' as const, label: 'Dépôt', title: x.nom })),
        ...shown.flatMap((c) =>
          c.arrets.flatMap((s, i) =>
            s.geo ? [{ id: `s-${s.missionId}`, ...s.geo, kind: s.statut === 'TERMINEE' ? ('stop-done' as const) : ('stop' as const), label: String(s.ordre ?? i + 1), title: `${c.nom} · ${s.client ?? ''} · ${MISSION_STATUS[s.statut] ?? s.statut}` }] : [],
          ),
        ),
        ...shown.flatMap((c) =>
          c.position ? [{ id: `c-${c.id}`, lat: c.position.lat, lng: c.position.lng, kind: c.position.fraiche ? ('driver' as const) : ('driver-stale' as const), label: initials(c.nom), title: `${c.nom} · ${ago(c.position.at, d.maintenant)}` }] : [],
        ),
      ]
    : [];
  const actifs = d?.chauffeurs.filter((c) => c.total > 0) ?? [];

  return (
    <>
      <section className="bo-head">
        <div>
          <p className="eyebrow">— Planning</p>
          <h1>Carte des chauffeurs</h1>
          <p className="lead">Où sont les chauffeurs et où en sont leurs arrêts du jour. Les positions ne sont connues que pendant un trajet en cours.</p>
        </div>
        {d && <p className="muted">Mis à jour à {timeFr(d.maintenant)} · rafraîchi toutes les 30 s</p>}
      </section>
      <PlanningTabs active="carte" date={d?.date} />
      {error && <Banner kind="error">{error}</Banner>}
      {!d ? (
        !error && <p className="hint">Chargement…</p>
      ) : (
        <div className="fleet-layout">
          <LiveMap tiles={d.tuiles} points={points} height={560} label="Carte des chauffeurs et de leurs arrêts" />
          <section className="fleet-list" aria-label="Chauffeurs">
            {focus && (
              <button type="button" className="link" onClick={() => setFocus(null)}>
                ← Tous les chauffeurs
              </button>
            )}
            {actifs.length === 0 && <p className="empty">Aucun chauffeur n’a d’arrêt aujourd’hui.</p>}
            {actifs.map((c) => (
              <article key={c.id} className={`panel fleet-card${focus === c.id ? ' selected' : ''}`}>
                <header>
                  <button type="button" className="fleet-name" onClick={() => setFocus(focus === c.id ? null : c.id)} aria-pressed={focus === c.id}>
                    <span className={`fleet-dot ${c.position ? (c.position.fraiche ? 'live' : 'stale') : 'off'}`} aria-hidden />
                    <strong>{c.nom}</strong>
                  </button>
                  {c.telephone && (
                    <a className="btn small" href={`tel:${c.telephone}`}>
                      Appeler
                    </a>
                  )}
                </header>
                <p className="muted">
                  {c.tournee ? `Tournée ${c.tournee} · ` : ''}
                  {c.faits} / {c.total} arrêt{c.total > 1 ? 's' : ''} fait{c.total > 1 ? 's' : ''}
                </p>
                <div className="meter" role="progressbar" aria-label={`Avancement de ${c.nom}`} aria-valuemin={0} aria-valuemax={c.total} aria-valuenow={c.faits}>
                  <span style={{ width: `${c.total ? (c.faits / c.total) * 100 : 0}%` }} />
                </div>
                {c.enCours ? (
                  <div className="fleet-current">
                    <StatusPill label={c.enCours.etape === 'ARRIVE' ? 'Sur place' : 'En route'} tone={c.enCours.etape === 'ARRIVE' ? 'ok' : 'route'} />
                    <span>
                      <strong>{c.enCours.client}</strong> · {c.enCours.numero}
                      <small>{c.enCours.adresse}</small>
                      {c.enCours.eta && <small>Arrivée estimée {timeFr(c.enCours.eta)}</small>}
                    </span>
                  </div>
                ) : (
                  <p className="hint">Pas de trajet en cours.</p>
                )}
                {c.position ? (
                  <p className={c.position.fraiche ? 'muted small' : 'small alert-text'}>
                    Position {ago(c.position.at, d.maintenant)}
                    {!c.position.fraiche ? ' : plus de nouvelle depuis 10 min, appelez le chauffeur.' : ''}
                  </p>
                ) : c.enCours?.etape === 'EN_ROUTE' ? (
                  <p className="small alert-text">Aucune position reçue depuis le départ (GPS coupé ou hors réseau).</p>
                ) : null}
                <ol className="fleet-stops">
                  {c.arrets.map((s) => (
                    <li key={s.missionId} className={`s-${s.statut.toLowerCase()}`}>
                      <span className="stop-n" aria-hidden>
                        {s.ordre ?? '·'}
                      </span>
                      <span>
                        {s.client} <span className="muted">· {MISSION_STATUS[s.statut] ?? s.statut}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </article>
            ))}
          </section>
        </div>
      )}
    </>
  );
}
