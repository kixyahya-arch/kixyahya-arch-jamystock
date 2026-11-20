import { useEffect, useState } from 'react';
import { Scanner } from '../components/Scanner';
import { Banner, Screen } from '../components/ui';
import { enqueue } from '../lib/outbox';
import { markGet, markSet } from '../lib/db';
import { feedback } from '../lib/device';
import { loadMission, type MissionDetail } from '../lib/data';

/**
 * CMD-09 : sortir d'une palette (UM) les seuls biens commandés, la veille de la préparation.
 * Chaque bien scanné quitte l'UM ; le reste de la palette ne bouge pas.
 */
export function Degroupage({ missionId, onBack }: { missionId: string; onBack: () => void }) {
  const [m, setM] = useState<MissionDetail | undefined>();
  const [done, setDone] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const key = `degroupage:${missionId}`;

  useEffect(() => {
    void loadMission(missionId).then((r) => {
      setM(r.data);
      const fromServer = r.data?.lignes.filter((l) => l.umADegrouper && !l.resteSurUm).map((l) => l.articleId!) ?? [];
      void markGet<string[]>(key, []).then((local) => setDone([...new Set([...local, ...fromServer])]));
    });
  }, [missionId, key]);

  if (!m) return <Screen title="Dégroupage" onBack={onBack}>{<p className="hint">Chargement…</p>}</Screen>;
  const lines = m.lignes.filter((l) => l.articleId && l.umADegrouper);
  const todo = lines.filter((l) => !done.includes(l.articleId!));
  const pallets = [...new Set(lines.map((l) => l.umADegrouper!))];

  const onScan = async (qr: string) => {
    const line = lines.find((l) => l.qrCode === qr);
    if (!line) {
      feedback('error');
      setError('Ce bien n’est pas à sortir de la palette : laissez-le en place.');
      return;
    }
    setError(null);
    if (done.includes(line.articleId!)) return;
    await enqueue({ type: 'UM_SPLIT', payload: { missionId, articleQr: qr } });
    const next = [...done, line.articleId!];
    setDone(next);
    await markSet(key, next);
  };

  return (
    <Screen title="Dégroupage" onBack={onBack}>
      <p className="hint">
        Commande {m.commande?.numero} · palette{pallets.length > 1 ? 's' : ''} <span className="mono">{pallets.join(', ')}</span> · {done.length} / {lines.length} sortis
      </p>
      <Banner kind="info">Sortez seulement les biens listés. Les autres biens de la palette restent rangés à leur place.</Banner>
      {error && <Banner kind="error">{error}</Banner>}
      {todo.length > 0 ? (
        <Scanner expect={['A']} burst label="Scannez chaque bien sorti de la palette" onScan={(qr) => void onScan(qr)} />
      ) : (
        <Banner kind="ok">✓ Tous les biens sont sortis. La préparation pourra les prélever normalement.</Banner>
      )}
      <ul className="list picklist">
        {lines.map((l) => {
          const ok = done.includes(l.articleId!);
          return (
            <li key={l.id} className={`pick ${ok ? 'ok' : ''}`}>
              <span className="check" aria-hidden="true">
                {ok ? '✓' : ''}
              </span>
              <span className="row-main">
                <strong>{l.libelle}</strong>
                <small>
                  <span className="mono">{l.qrCode}</span> · palette <span className="mono">{l.umADegrouper}</span>
                  {l.chemin ? ` · ${l.chemin.split(' > ').slice(1).join(' › ') || l.chemin}` : ''}
                </small>
              </span>
            </li>
          );
        })}
      </ul>
      {todo.length === 0 && (
        <button type="button" className="btn primary big" onClick={onBack}>
          Mission suivante
        </button>
      )}
    </Screen>
  );
}
