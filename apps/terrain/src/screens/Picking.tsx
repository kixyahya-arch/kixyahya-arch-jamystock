import { useEffect, useState } from 'react';
import { Scanner } from '../components/Scanner';
import { PhotoCapture, type CapturedPhoto } from '../components/PhotoCapture';
import { Banner, Screen } from '../components/ui';
import { enqueue, enqueuePhoto } from '../lib/outbox';
import { markGet, markSet } from '../lib/db';
import { feedback } from '../lib/device';
import { loadMission, type MissionDetail, type MissionLine } from '../lib/data';

interface Progress {
  picked: string[];
  missing: string[];
  completed: boolean;
  loaded: string[];
}
const EMPTY: Progress = { picked: [], missing: [], completed: false, loaded: [] };

/** PRP-01 à PRP-03 : prélèvement trié par chemin, validé par scan, puis chargement scanné. */
export function Picking({ missionId, onBack }: { missionId: string; onBack: () => void }) {
  const [m, setM] = useState<MissionDetail | undefined>();
  const [p, setP] = useState<Progress>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [missingFor, setMissingFor] = useState<MissionLine | null>(null);
  const key = `progress:${missionId}`;

  useEffect(() => {
    void loadMission(missionId).then((r) => {
      setM(r.data);
      // reprise : ce que le serveur sait déjà vaut ce que le terminal a noté
      const fromServer: Progress = {
        picked: r.data?.lignes.filter((l) => ['PREPAREE', 'CHARGEE'].includes(l.statutLigne)).map((l) => l.articleId!) ?? [],
        missing: r.data?.lignes.filter((l) => l.statutLigne === 'MANQUANTE').map((l) => l.articleId!) ?? [],
        completed: r.data?.statut === 'TERMINEE',
        loaded: r.data?.lignes.filter((l) => l.statutLigne === 'CHARGEE').map((l) => l.articleId!) ?? [],
      };
      void markGet<Progress>(key, EMPTY).then((local) =>
        setP({
          picked: [...new Set([...local.picked, ...fromServer.picked])],
          missing: [...new Set([...local.missing, ...fromServer.missing])],
          completed: local.completed || fromServer.completed,
          loaded: [...new Set([...local.loaded, ...fromServer.loaded])],
        }),
      );
    });
  }, [missionId, key]);

  const save = async (next: Progress) => {
    setP(next);
    await markSet(key, next);
  };

  if (!m) return <Screen title="Préparation" onBack={onBack}>{<p className="hint">Chargement…</p>}</Screen>;
  const lines = m.lignes.filter((l) => l.articleId);
  const toPick = lines.filter((l) => !p.picked.includes(l.articleId!) && !p.missing.includes(l.articleId!));
  const toLoad = lines.filter((l) => p.picked.includes(l.articleId!) && !p.loaded.includes(l.articleId!));
  const loading = p.completed;

  const onScan = async (qr: string) => {
    const line = lines.find((l) => l.qrCode === qr);
    // PRP-02 : scan hors commande = alerte bloquante, rien n'est envoyé
    if (!line) {
      feedback('error');
      setError(`Cet article ne fait pas partie de la commande ${m.commande?.numero}. Remettez-le en place.`);
      return;
    }
    setError(null);
    if (!loading) {
      if (p.picked.includes(line.articleId!)) return;
      await enqueue({ type: 'PICK', payload: { missionId, articleQr: qr } });
      await save({ ...p, picked: [...p.picked, line.articleId!] });
    } else {
      if (!p.picked.includes(line.articleId!)) {
        feedback('error');
        setError('Article non préparé : il ne doit pas partir.');
        return;
      }
      if (p.loaded.includes(line.articleId!)) return;
      await enqueue({ type: 'LOAD', payload: { missionId, articleQr: qr } });
      await save({ ...p, loaded: [...p.loaded, line.articleId!] });
    }
  };

  if (missingFor) {
    return (
      <MissingForm
        line={missingFor}
        onCancel={() => setMissingFor(null)}
        onSubmit={async (photo, commentaire) => {
          if (photo) await enqueuePhoto(photo.photoId, photo.blob, 0);
          await enqueue({ type: 'PICK_MISSING', payload: { missionId, articleId: missingFor.articleId!, photoId: photo?.photoId, commentaire } });
          await save({ ...p, missing: [...p.missing, missingFor.articleId!] });
          setMissingFor(null);
        }}
      />
    );
  }

  const shown = loading ? toLoad : toPick;
  return (
    <Screen title={loading ? 'Chargement' : 'Préparation'} onBack={onBack}>
      <p className="hint">
        Commande {m.commande?.numero} ·{' '}
        {loading ? `${p.loaded.length} / ${p.picked.length} chargés` : `${p.picked.length + p.missing.length} / ${lines.length} traités`}
      </p>
      {error && <Banner kind="error">{error}</Banner>}
      {shown.length > 0 && <Scanner expect={['A']} burst label={loading ? 'Scannez chaque article au chargement' : 'Scannez l’article prélevé'} onScan={(qr) => void onScan(qr)} />}

      <ul className="list picklist">
        {shown.map((l) => (
          <li key={l.id} className="pick">
            <span className="thumb" aria-hidden="true">
              {(l.libelle ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <span className="row-main">
              <strong>{l.libelle}</strong>
              <small>{l.chemin ? l.chemin.split(' > ').slice(1).join(' › ') || l.chemin : 'Emplacement inconnu'}</small>
            </span>
            {!loading && (
              <button type="button" className="btn secondary small" onClick={() => setMissingFor(l)}>
                Introuvable
              </button>
            )}
          </li>
        ))}
      </ul>

      {!loading && toPick.length === 0 && (
        <button
          type="button"
          className="btn primary big"
          onClick={async () => {
            await enqueue({ type: 'PICK_COMPLETE', payload: { missionId } });
            await save({ ...p, completed: true });
          }}
        >
          Terminer la préparation
        </button>
      )}
      {loading && toLoad.length === 0 && <Banner kind="ok">✓ Tout est chargé. Le chauffeur peut partir.</Banner>}
    </Screen>
  );
}

function MissingForm({ line, onSubmit, onCancel }: { line: MissionLine; onSubmit: (p: CapturedPhoto | undefined, c: string) => void; onCancel: () => void }) {
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [comment, setComment] = useState('');
  return (
    <Screen title="Article introuvable" onBack={onCancel}>
      <p>
        <strong>{line.libelle}</strong> · {line.chemin}
      </p>
      <PhotoCapture photos={photos} onChange={setPhotos} min={1} max={1} label="Photo de l’emplacement vide" />
      <label>
        Commentaire
        <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      <button type="button" className="btn danger big" disabled={!photos.length} onClick={() => onSubmit(photos[0], comment)}>
        Déclarer l’anomalie
      </button>
    </Screen>
  );
}
