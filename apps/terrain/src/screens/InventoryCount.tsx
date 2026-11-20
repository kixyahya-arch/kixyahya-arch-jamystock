import { useEffect, useState } from 'react';
import { Scanner } from '../components/Scanner';
import { Banner, Screen } from '../components/ui';
import { enqueue } from '../lib/outbox';
import { markGet, markSet } from '../lib/db';
import { feedback } from '../lib/device';
import { loadMission, type MissionDetail } from '../lib/data';

type Loc = NonNullable<MissionDetail['comptage']>['emplacements'][number];
interface Local {
  /** emplacements comptés sur ce terminal (en plus de ce que le serveur sait déjà) */
  done: Record<string, number>;
  current: { id: string; scans: string[] } | null;
}
const EMPTY: Local = { done: {}, current: null };

/**
 * WMS-05 : inventaire tournant. Scanner l'emplacement, puis tout ce qui s'y trouve (articles ou palettes),
 * puis « Emplacement terminé ». Le stock attendu n'est pas affiché : les écarts sont calculés au serveur
 * et arbitrés au Back-Office. Fonctionne hors réseau ; recompter un emplacement remplace son comptage.
 */
export function InventoryCount({ missionId, onBack }: { missionId: string; onBack: () => void }) {
  const [m, setM] = useState<MissionDetail | undefined>();
  const [st, setSt] = useState<Local>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const key = `inventaire:${missionId}`;

  useEffect(() => {
    void loadMission(missionId).then((r) => setM(r.data));
    void markGet<Local>(key, EMPTY).then(setSt);
  }, [missionId, key]);
  const save = async (next: Local) => {
    setSt(next);
    await markSet(key, next);
  };

  const c = m?.comptage;
  if (!m || !c) return <Screen title="Inventaire" onBack={onBack}>{<p className="hint">Chargement…</p>}</Screen>;
  const isDone = (l: Loc) => l.compte || st.done[l.id] !== undefined;
  const left = c.emplacements.filter((l) => !isDone(l));
  const current = st.current ? c.emplacements.find((l) => l.id === st.current!.id) : null;

  const onLocation = async (qr: string) => {
    const l = c.emplacements.find((x) => x.qrCode === qr);
    if (!l) {
      feedback('error');
      setError('Cet emplacement ne fait pas partie de ce comptage.');
      return;
    }
    setError(null);
    setInfo(isDone(l) ? `Recomptage de ${l.code} : ce comptage remplacera le précédent.` : null);
    await save({ ...st, current: { id: l.id, scans: [] } });
  };
  const onItem = async (qr: string) => {
    if (!st.current) return;
    if (st.current.scans.includes(qr)) {
      setInfo(`${qr} déjà scanné ici.`);
      return;
    }
    setInfo(null);
    await save({ ...st, current: { ...st.current, scans: [...st.current.scans, qr] } });
  };
  const finish = async () => {
    if (!st.current || !current) return;
    await enqueue({ type: 'LOCATION_COUNT', payload: { missionId, locationQr: current.qrCode, qrs: st.current.scans } });
    setInfo(`✓ ${current.code} compté : ${st.current.scans.length} étiquette${st.current.scans.length > 1 ? 's' : ''}.`);
    await save({ done: { ...st.done, [current.id]: st.current.scans.length }, current: null });
  };

  return (
    <Screen title={`Inventaire${c.numero ? ` ${c.numero}` : ''}`} onBack={onBack}>
      <p className="hint">
        {c.zone}
        {c.partie > 1 ? ` · partie ${c.partie}` : ''} · {c.emplacements.length - left.length} / {c.emplacements.length} emplacements comptés
      </p>
      {error && <Banner kind="error">{error}</Banner>}
      {info && <Banner kind={info.startsWith('✓') ? 'ok' : 'info'}>{info}</Banner>}

      {current ? (
        <section className="card count-card">
          <strong>
            Emplacement <span className="mono">{current.code}</span>
          </strong>
          <small>{current.chemin}</small>
          <Scanner expect={['A', 'U']} burst label="Scannez tout ce qui est sur l’emplacement" onScan={(qr) => void onItem(qr)} />
          {st.current!.scans.length > 0 && (
            <ul className="scan-list">
              {st.current!.scans.map((s) => (
                <li key={s}>
                  <span className="mono">{s}</span>
                  <button type="button" className="link" aria-label={`Retirer ${s}`} onClick={() => void save({ ...st, current: { ...st.current!, scans: st.current!.scans.filter((x) => x !== s) } })}>
                    Retirer
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="btn primary big" onClick={() => void finish()}>
            {st.current!.scans.length ? `Emplacement terminé (${st.current!.scans.length})` : 'Emplacement vide : terminé'}
          </button>
          <button type="button" className="btn secondary" onClick={() => void save({ ...st, current: null })}>
            Changer d’emplacement
          </button>
        </section>
      ) : left.length ? (
        <Scanner expect={['E']} label="Scannez l’emplacement à compter" onScan={(qr) => void onLocation(qr)} />
      ) : (
        <Banner kind="ok">✓ Tous les emplacements sont comptés. Les écarts éventuels partent au Back-Office pour arbitrage.</Banner>
      )}

      <ul className="list picklist">
        {c.emplacements.map((l) => {
          const done = isDone(l);
          return (
            <li key={l.id} className={`pick ${done ? 'ok' : ''} ${current?.id === l.id ? 'current' : ''}`}>
              <span className="check" aria-hidden="true">
                {done ? '✓' : ''}
              </span>
              <span className="row-main">
                <strong className="mono">{l.code}</strong>
                <small>
                  {l.chemin.split(' > ').slice(1).join(' › ')}
                  {done ? ` · ${st.done[l.id] ?? l.trouves} scanné(s)` : ''}
                </small>
              </span>
            </li>
          );
        })}
      </ul>
      {!left.length && (
        <button type="button" className="btn primary big" onClick={onBack}>
          Mission suivante
        </button>
      )}
    </Screen>
  );
}
