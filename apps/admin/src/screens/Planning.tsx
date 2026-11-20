import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { get, post } from '../lib/api';
import { go, href } from '../lib/router';
import type { Mission, Planning, Resource, Vehicle } from '../lib/types';
import { MISSION_STATUS, MISSION_TYPE, ROLE, addDays, dateFr, roleFor, timeFr } from '../lib/labels';
import { Banner, StatusPill } from '../components/ui';
import { AssignForm } from '../components/Assign';

/**
 * FLX-03 : planning d'une journée par ressource. On glisse une mission de la colonne « À affecter » vers un chauffeur
 * ou un opérateur ; chaque carte garde aussi un formulaire d'affectation (clavier, tablette).
 */
export function PlanningView({ date }: { date: string }) {
  const [p, setP] = useState<Planning | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState<Mission | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const load = useCallback(() => {
    get<Planning>(`/bo/planning?date=${date}`)
      .then((r) => {
        setP(r);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [date]);
  useEffect(load, [load]);

  const assign = async (m: Mission, r: Resource) => {
    if (roleFor(m.type) !== r.role) {
      setError(`Une mission de ${MISSION_TYPE[m.type]?.toLowerCase() ?? m.type} va à un ${roleFor(m.type) === 'DRIVER' ? 'chauffeur' : 'opérateur'}.`);
      return;
    }
    try {
      const vehiculeId = r.role === 'DRIVER' ? (m.vehiculeId ?? smallestFitting(m, p?.vehicules ?? [])) : undefined;
      const res = await post<{ warnings: string[] }>(`/missions/${m.id}/assign`, { assigneA: r.id, ...(vehiculeId ? { vehiculeId } : {}) });
      setNotice(`${MISSION_TYPE[m.type]} ${m.numero ?? ''} affectée à ${r.nom}.${res.warnings?.length ? ` Attention : ${res.warnings.join(' ; ')}` : ''}`);
      setError(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const columns: { key: string; title: string; sub?: string; resource?: Resource; missions: Mission[] }[] = p
    ? [
        { key: 'todo', title: 'À affecter', missions: p.missions.filter((m) => !m.assigneA) },
        ...p.ressources.map((r) => ({
          key: r.id,
          title: r.nom,
          sub: ROLE[r.role],
          resource: r,
          missions: p.missions.filter((m) => m.assigneA === r.id),
        })),
      ]
    : [];

  const drop = (col: (typeof columns)[number]) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    if (dragging && col.resource && dragging.assigneA !== col.resource.id) void assign(dragging, col.resource);
    setDragging(null);
  };

  return (
    <>
      <section className="bo-head">
        <div>
          <p className="eyebrow">— Planning des missions</p>
          <h1 className="cap">{dateFr(date)}</h1>
        </div>
        <div className="day-nav" role="group" aria-label="Changer de jour">
          <button type="button" className="btn small" onClick={() => go({ name: 'planning', date: addDays(date, -1) })}>
            ← Veille
          </button>
          <input type="date" aria-label="Jour" value={date} onChange={(e) => e.target.value && go({ name: 'planning', date: e.target.value })} />
          <button type="button" className="btn small" onClick={() => go({ name: 'planning', date: addDays(date, 1) })}>
            Lendemain →
          </button>
        </div>
      </section>

      {notice && <Banner kind="ok">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
      {!p ? (
        !error && <p className="hint">Chargement…</p>
      ) : (
        <>
          <p className="hint">Glissez une mission sur un chauffeur (livraisons, collectes) ou un opérateur (préparations, retraits). Le véhicule le plus petit qui convient est proposé.</p>
          <div className="board">
            {columns.map((col) => {
              const vol = col.missions.reduce((s, m) => s + (m.volumeM3 ?? 0), 0);
              return (
                <section
                  key={col.key}
                  className={`bcol${col.key === 'todo' ? ' todo' : ''}${over === col.key ? ' over' : ''}${dragging && col.resource && roleFor(dragging.type) !== col.resource.role ? ' refuse' : ''}`}
                  aria-label={col.title}
                  onDragOver={(e) => {
                    if (!col.resource) return;
                    e.preventDefault();
                    setOver(col.key);
                  }}
                  onDragLeave={() => setOver((o) => (o === col.key ? null : o))}
                  onDrop={drop(col)}
                >
                  <header>
                    <h2>{col.title}</h2>
                    <span className="muted">
                      {col.sub ? `${col.sub} · ` : ''}
                      {col.missions.length} mission{col.missions.length > 1 ? 's' : ''}
                      {vol > 0 ? ` · ${vol.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} m³` : ''}
                    </span>
                  </header>
                  {col.missions.length === 0 && <p className="drop-hint">{col.resource ? 'Rien de prévu' : 'Tout est affecté'}</p>}
                  {col.missions.map((m) => (
                    <MissionCard
                      key={m.id}
                      m={m}
                      late={m.statut === 'A_AFFECTER' && !!m.debutPrevu && parisDay(m.debutPrevu) < parisDay(new Date().toISOString())}
                      p={p}
                      onDragStart={() => setDragging(m)}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                      onAssigned={(w) => {
                        setNotice(w.length ? `Mission affectée. Attention : ${w.join(' ; ')}` : 'Mission affectée.');
                        load();
                      }}
                    />
                  ))}
                </section>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

function MissionCard({
  m,
  late,
  p,
  onDragStart,
  onDragEnd,
  onAssigned,
}: {
  m: Mission;
  late: boolean;
  p: Planning;
  onDragStart: () => void;
  onDragEnd: () => void;
  onAssigned: (w: string[]) => void;
}) {
  const movable = ['A_AFFECTER', 'AFFECTEE'].includes(m.statut);
  return (
    <article
      className={`mcard t-${m.type.toLowerCase()}${late ? ' late' : ''}`}
      draggable={movable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', m.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <div className="mcard-top">
        <strong>{MISSION_TYPE[m.type] ?? m.type}</strong>
        <span className="mono">{timeFr(m.debutPrevu)}</span>
      </div>
      {late && <span className="kwarn">En retard : prévue le {dateFr(m.debutPrevu)}</span>}
      <span>{m.client}</span>
      {m.typeCommande !== 'RETRAIT' && m.type !== 'PREPARATION' && m.adresse && <span className="muted">{m.adresse}</span>}
      {m.type === 'PHOTO' && m.articleId && (
        <span className="photo-req">
          <a href={href({ name: 'article', id: m.articleId })}>{m.articleLibelle}</a>
          <small>
            {m.demande === 'CONSTAT' ? 'Constat d’état' : 'Photo supplémentaire'}
            {m.demandeMessage ? ` : « ${m.demandeMessage} »` : ''}
          </small>
        </span>
      )}
      <span className="muted">
        {m.numero && (
          <a href={href({ name: 'demande', id: m.commandeId! })} className="mono">
            {m.numero}
          </a>
        )}
        {m.creneau ? ` · ${m.creneau}` : ''}
        {m.nbLignes ? ` · ${m.nbLignes} ligne${m.nbLignes > 1 ? 's' : ''}` : ''}
        {m.volumeM3 ? ` · ${m.volumeM3.toLocaleString('fr-FR')} m³` : ''}
      </span>
      <div className="mcard-foot">
        <StatusPill label={MISSION_STATUS[m.statut] ?? m.statut} tone={m.statut === 'A_AFFECTER' ? 'lime' : m.statut === 'ANOMALIE' ? 'alert' : 'neutral'} />
        {m.vehicule && <span className="veh">{m.vehicule}</span>}
      </div>
      {!m.assigneA && movable && <AssignForm mission={m} ressources={p.ressources} vehicules={p.vehicules} onDone={onAssigned} />}
    </article>
  );
}

/** Jour calendaire à Paris (AAAA-MM-JJ) d'un instant. */
const parisDay = (iso: string) => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });

function smallestFitting(m: Mission, vehicules: Vehicle[]): string | undefined {
  return vehicules.find((v) => v.volumeM3 >= (m.volumeM3 ?? 0))?.id;
}
