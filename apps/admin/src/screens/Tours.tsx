import { useCallback, useEffect, useMemo, useState } from 'react';
import { get, post, put } from '../lib/api';
import { go, href } from '../lib/router';
import { addDays, dateFr, MISSION_STATUS } from '../lib/labels';
import { Banner, PlanningTabs, StatusPill } from '../components/ui';
import { LiveMap, type MapPoint } from '../components/LiveMap';

interface Stop {
  missionId: string;
  tourneeId: string | null;
  ordre: number | null;
  type: 'LIVRAISON' | 'COLLECTE';
  statut: string;
  numero: string | null;
  client: string | null;
  adresse: string | null;
  geo: { lat: number; lng: number } | null;
  creneau: string | null;
  volumeM3: number | null;
  poidsKg: number | null;
  arriveLe: string | null;
}
interface Tour {
  id: string;
  numero: string;
  nom: string | null;
  statut: 'PLANIFIEE' | 'EN_COURS' | 'TERMINEE';
  chauffeurId: string | null;
  chauffeur: string | null;
  vehiculeId: string | null;
  vehicule: string | null;
  arrets: Stop[];
  faits: number;
  volumeM3: number;
  poidsKg: number;
  kmEstimes: number | null;
  alertes: string[];
}
interface ToursData {
  date: string;
  depot: { lat: number; lng: number } | null;
  tuiles: string;
  tournees: Tour[];
  disponibles: Stop[];
  chauffeurs: { id: string; nom: string }[];
  vehicules: { id: string; immatriculation: string; type: string; volumeM3: number; chargeUtileKg: number }[];
}
interface Draft {
  chauffeurId: string;
  vehiculeId: string;
  nom: string;
  ids: string[];
}

const TOUR_STATUS: Record<Tour['statut'], string> = { PLANIFIEE: 'Planifiée', EN_COURS: 'En cours', TERMINEE: 'Terminée' };
const TYPE: Record<Stop['type'], string> = { LIVRAISON: 'Livraison', COLLECTE: 'Collecte' };

/**
 * FLX-04 : tournées du jour. On coche les arrêts à placer, on crée la tournée (chauffeur, véhicule), puis on
 * ordonne les arrêts à la main en suivant le trajet sur la carte et les kilomètres estimés.
 */
export function ToursView({ date }: { date: string }) {
  const [d, setD] = useState<ToursData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [creating, setCreating] = useState<Omit<Draft, 'ids'>>({ chauffeurId: '', vehiculeId: '', nom: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    get<ToursData>(`/bo/tournees?date=${date}`)
      .then((r) => {
        setD(r);
        setDrafts({});
        setPicked((p) => p.filter((id) => r.disponibles.some((s) => s.missionId === id)));
        setSelected((s) => (s && r.tournees.some((t) => t.id === s) ? s : (r.tournees[0]?.id ?? null)));
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [date]);
  useEffect(load, [load]);

  const stopById = useMemo(() => new Map([...(d?.disponibles ?? []), ...(d?.tournees.flatMap((t) => t.arrets) ?? [])].map((s) => [s.missionId, s])), [d]);
  const draftOf = (t: Tour): Draft => drafts[t.id] ?? { chauffeurId: t.chauffeurId ?? '', vehiculeId: t.vehiculeId ?? '', nom: t.nom ?? '', ids: t.arrets.map((a) => a.missionId) };
  const setDraft = (t: Tour, patch: Partial<Draft>) => setDrafts((x) => ({ ...x, [t.id]: { ...draftOf(t), ...patch } }));
  const dirty = (t: Tour) => !!drafts[t.id];

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      setNotice(ok);
      setError(null);
      load();
    } catch (e) {
      setError((e as Error).message);
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => {
      const r = await post<{ id: string; numero: string }>('/bo/tournees', { date, chauffeurId: creating.chauffeurId, vehiculeId: creating.vehiculeId || null, nom: creating.nom || null, missionIds: picked });
      setSelected(r.id);
      setPicked([]);
    }, `Tournée créée avec ${picked.length} arrêt${picked.length > 1 ? 's' : ''}. Ordonnez-les puis prévenez le chauffeur.`);

  const save = (t: Tour, ids = draftOf(t).ids) => {
    const dr = draftOf(t);
    return run(() => put(`/bo/tournees/${t.id}`, { chauffeurId: dr.chauffeurId, vehiculeId: dr.vehiculeId || null, nom: dr.nom || null, missionIds: ids }), `Tournée ${t.numero} enregistrée.`);
  };

  const sel = d?.tournees.find((t) => t.id === selected) ?? null;
  const selIds = sel ? draftOf(sel).ids : [];
  const points: MapPoint[] = [
    ...(d?.depot ? [{ id: 'depot', ...d.depot, kind: 'depot' as const, label: 'Dépôt' }] : []),
    ...selIds.flatMap((id, i) => {
      const s = stopById.get(id);
      return s?.geo ? [{ id, ...s.geo, kind: s.statut === 'TERMINEE' ? ('stop-done' as const) : ('stop' as const), label: String(i + 1), title: `${i + 1}. ${s.client ?? ''} · ${s.adresse ?? ''}` }] : [];
    }),
    ...picked.flatMap((id) => {
      const s = stopById.get(id);
      return s?.geo ? [{ id: `p-${id}`, ...s.geo, kind: 'stop-done' as const, label: '+', title: `À placer : ${s.client ?? ''}` }] : [];
    }),
  ];
  const route: [number, number][] = d?.depot
    ? [[d.depot.lat, d.depot.lng], ...selIds.flatMap((id) => (stopById.get(id)?.geo ? [[stopById.get(id)!.geo!.lat, stopById.get(id)!.geo!.lng] as [number, number]] : [])), [d.depot.lat, d.depot.lng]]
    : [];

  return (
    <>
      <section className="bo-head">
        <div>
          <p className="eyebrow">— Tournées</p>
          <h1 className="cap">{dateFr(date)}</h1>
        </div>
        <div className="day-nav" role="group" aria-label="Changer de jour">
          <button type="button" className="btn small" onClick={() => go({ name: 'tournees', date: addDays(date, -1) })}>
            ← Veille
          </button>
          <input type="date" aria-label="Jour" value={date} onChange={(e) => e.target.value && go({ name: 'tournees', date: e.target.value })} />
          <button type="button" className="btn small" onClick={() => go({ name: 'tournees', date: addDays(date, 1) })}>
            Lendemain →
          </button>
        </div>
      </section>
      <PlanningTabs active="tournees" date={date} />
      {notice && <Banner kind="ok">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
      {!d ? (
        !error && <p className="hint">Chargement…</p>
      ) : (
        <div className="tours-layout">
          <section className="panel" aria-labelledby="stops-title">
            <h2 id="stops-title">Arrêts à placer</h2>
            {d.disponibles.length === 0 ? (
              <p className="empty">Toutes les livraisons et collectes du jour sont dans une tournée.</p>
            ) : (
              <ul className="stop-pick">
                {d.disponibles.map((s) => (
                  <li key={s.missionId}>
                    <label>
                      <input type="checkbox" checked={picked.includes(s.missionId)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.missionId] : p.filter((x) => x !== s.missionId)))} />
                      <span>
                        <strong>{s.client}</strong> <span className="muted">· {TYPE[s.type]} {s.numero}</span>
                        <small>
                          {s.adresse}
                          {s.creneau ? ` · ${s.creneau}` : ''}
                          {s.volumeM3 ? ` · ${s.volumeM3.toLocaleString('fr-FR')} m³` : ''}
                          {!s.geo ? ' · adresse non localisée' : ''}
                        </small>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {picked.length > 0 && (
              <div className="tour-create">
                <h3>
                  {picked.length} arrêt{picked.length > 1 ? 's' : ''} sélectionné{picked.length > 1 ? 's' : ''}
                </h3>
                {d.tournees.filter((t) => t.statut !== 'TERMINEE').map((t) => (
                  <button key={t.id} type="button" className="btn small" disabled={busy} onClick={() => void save(t, [...draftOf(t).ids, ...picked]).then(() => setPicked([]))}>
                    Ajouter à {t.numero}
                    {t.chauffeur ? ` (${t.chauffeur})` : ''}
                  </button>
                ))}
                <form
                  className="tour-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void create();
                  }}
                >
                  <label>
                    Chauffeur
                    <select required value={creating.chauffeurId} onChange={(e) => setCreating({ ...creating, chauffeurId: e.target.value })}>
                      <option value="">Choisir…</option>
                      {d.chauffeurs.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.nom}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Véhicule
                    <select value={creating.vehiculeId} onChange={(e) => setCreating({ ...creating, vehiculeId: e.target.value })}>
                      <option value="">Plus tard</option>
                      {d.vehicules.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.immatriculation} · {v.volumeM3} m³
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Nom (facultatif)
                    <input value={creating.nom} maxLength={80} placeholder="Ex. Ouest parisien" onChange={(e) => setCreating({ ...creating, nom: e.target.value })} />
                  </label>
                  <button type="submit" className="btn primary" disabled={busy || !creating.chauffeurId}>
                    Créer une tournée
                  </button>
                </form>
              </div>
            )}
          </section>

          <section className="tours-main">
            {d.tournees.length === 0 ? (
              <p className="empty">Aucune tournée ce jour. Cochez des arrêts pour en créer une.</p>
            ) : (
              <div className="tour-tabs" role="tablist" aria-label="Tournées du jour">
                {d.tournees.map((t) => (
                  <button key={t.id} type="button" role="tab" aria-selected={t.id === selected} className={t.id === selected ? 'active' : ''} onClick={() => setSelected(t.id)}>
                    <strong>{t.numero}</strong>
                    <span>
                      {t.chauffeur ?? 'Sans chauffeur'} · {t.faits}/{t.arrets.length}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {sel && (
              <TourCard
                key={sel.id}
                t={sel}
                d={d}
                draft={draftOf(sel)}
                dirty={dirty(sel)}
                busy={busy}
                stopById={stopById}
                onChange={(p) => setDraft(sel, p)}
                onSave={() => void save(sel)}
                onReset={() => setDrafts(({ [sel.id]: _x, ...rest }) => rest)}
                onCancel={() => void run(() => post(`/bo/tournees/${sel.id}/annuler`), `Tournée ${sel.numero} annulée : ses arrêts restent affectés au chauffeur.`)}
              />
            )}
            {(sel || picked.length > 0) && <LiveMap tiles={d.tuiles} points={points} route={route} height={380} label={sel ? `Trajet de la tournée ${sel.numero}` : 'Arrêts sélectionnés'} />}
          </section>
        </div>
      )}
    </>
  );
}

function TourCard({
  t,
  d,
  draft,
  dirty,
  busy,
  stopById,
  onChange,
  onSave,
  onReset,
  onCancel,
}: {
  t: Tour;
  d: ToursData;
  draft: Draft;
  dirty: boolean;
  busy: boolean;
  stopById: Map<string, Stop>;
  onChange: (p: Partial<Draft>) => void;
  onSave: () => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const move = (i: number, by: number) => {
    const ids = [...draft.ids];
    const [x] = ids.splice(i, 1);
    ids.splice(i + by, 0, x!);
    onChange({ ids });
  };
  const locked = (s: Stop | undefined) => !!s && (s.statut === 'EN_COURS' || s.statut === 'TERMINEE');
  return (
    <article className="panel tour-card" aria-label={`Tournée ${t.numero}`}>
      <header className="tour-head">
        <div>
          <h2>
            {t.numero} {t.nom && <span className="muted">· {t.nom}</span>}
          </h2>
          <p className="muted">
            {t.arrets.length} arrêt{t.arrets.length > 1 ? 's' : ''}
            {t.kmEstimes != null ? ` · ${t.kmEstimes.toLocaleString('fr-FR')} km estimés (aller-retour dépôt)` : ' · km non estimés (adresse non localisée)'}
            {t.volumeM3 ? ` · ${t.volumeM3.toLocaleString('fr-FR')} m³ à livrer` : ''}
          </p>
        </div>
        <StatusPill label={TOUR_STATUS[t.statut]} tone={t.statut === 'EN_COURS' ? 'lime' : t.statut === 'TERMINEE' ? 'dark' : 'neutral'} />
      </header>
      {t.alertes.map((a) => (
        <Banner key={a} kind="error">
          {a}
        </Banner>
      ))}
      <div className="tour-form inline">
        <label>
          Chauffeur
          <select value={draft.chauffeurId} onChange={(e) => onChange({ chauffeurId: e.target.value })}>
            {d.chauffeurs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nom}
              </option>
            ))}
          </select>
        </label>
        <label>
          Véhicule
          <select value={draft.vehiculeId} onChange={(e) => onChange({ vehiculeId: e.target.value })}>
            <option value="">Aucun</option>
            {d.vehicules.map((v) => (
              <option key={v.id} value={v.id}>
                {v.immatriculation} · {v.volumeM3} m³ · {v.chargeUtileKg} kg
              </option>
            ))}
          </select>
        </label>
        <label>
          Nom
          <input value={draft.nom} maxLength={80} onChange={(e) => onChange({ nom: e.target.value })} />
        </label>
      </div>
      <ol className="tour-stops">
        <li className="tour-depot">Départ du dépôt</li>
        {draft.ids.map((id, i) => {
          const s = stopById.get(id);
          return (
            <li key={id} className={`tour-stop s-${s?.statut.toLowerCase()}`}>
              <span className="stop-n" aria-hidden>
                {i + 1}
              </span>
              <span className="stop-main">
                <strong>{s?.client}</strong> <span className="muted">· {s ? TYPE[s.type] : ''} {s?.numero}</span>
                <small>
                  {s?.adresse}
                  {s?.creneau ? ` · ${s.creneau}` : ''}
                </small>
              </span>
              <span className="stop-state">{s && s.statut !== 'AFFECTEE' ? MISSION_STATUS[s.statut] ?? s.statut : ''}</span>
              <span className="row-actions">
                <button type="button" className="btn small" aria-label={`Monter ${s?.client ?? ''}`} disabled={i === 0 || locked(s)} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button type="button" className="btn small" aria-label={`Descendre ${s?.client ?? ''}`} disabled={i === draft.ids.length - 1 || locked(s)} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button type="button" className="btn small" aria-label={`Retirer ${s?.client ?? ''} de la tournée`} disabled={locked(s) || draft.ids.length === 1} onClick={() => onChange({ ids: draft.ids.filter((x) => x !== id) })}>
                  Retirer
                </button>
              </span>
            </li>
          );
        })}
        <li className="tour-depot">Retour au dépôt</li>
      </ol>
      <div className="row-actions">
        <button type="button" className="btn primary" disabled={!dirty || busy} onClick={onSave}>
          Enregistrer la tournée
        </button>
        {dirty && (
          <button type="button" className="btn" onClick={onReset}>
            Annuler les changements
          </button>
        )}
        <span className="spacer" />
        {t.statut === 'PLANIFIEE' && (
          <button type="button" className="link" onClick={onCancel}>
            Défaire la tournée
          </button>
        )}
        <a className="link" href={href({ name: 'carte' })}>
          Voir sur la carte des chauffeurs
        </a>
      </div>
      {dirty && <p className="hint">L’ordre et les kilomètres seront recalculés à l’enregistrement ; le chauffeur voit les arrêts dans cet ordre sur son terminal.</p>}
    </article>
  );
}
