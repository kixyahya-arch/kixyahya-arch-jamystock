import { useEffect, useState } from 'react';
import { ARTICLE_CONDITIONS, type ArticleCondition } from '@jamystock/domain/browser';
import { Scanner } from '../components/Scanner';
import { PhotoCapture, type CapturedPhoto } from '../components/PhotoCapture';
import { Banner, Choice, Screen } from '../components/ui';
import { enqueue, enqueuePhoto } from '../lib/outbox';
import { markGet, markSet } from '../lib/db';
import { feedback } from '../lib/device';
import { loadMission, type MissionDetail } from '../lib/data';

const CONDITION_LABEL: Record<ArticleCondition, string> = { NEUF: 'Neuf', BON: 'Bon', USE: 'Usé', ENDOMMAGE: 'Endommagé' };

/** INV-07 : photo ou constat demandé par le client. Scan du bien (le bon), photos, état constaté, puis envoi. */
export function PhotoRequest({ missionId, onBack }: { missionId: string; onBack: () => void }) {
  const [m, setM] = useState<MissionDetail | undefined>();
  const [scanned, setScanned] = useState(false);
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [etat, setEtat] = useState<ArticleCondition | null>(null);
  const [comment, setComment] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = `photo:${missionId}`;

  useEffect(() => {
    void loadMission(missionId).then((r) => {
      setM(r.data);
      setEtat((r.data?.demande?.article.etat as ArticleCondition | undefined) ?? null);
      if (r.data?.statut === 'TERMINEE') setDone(true);
    });
    void markGet<boolean>(key, false).then((sent) => sent && setDone(true));
  }, [missionId, key]);

  const title = m?.demande?.type === 'CONSTAT' ? 'Constat d’état' : 'Photo à la demande';
  if (!m) return <Screen title={title} onBack={onBack}>{<p className="hint">Chargement…</p>}</Screen>;
  const d = m.demande;
  if (!d) {
    return (
      <Screen title={title} onBack={onBack}>
        <Banner kind="error">Le bien de cette demande est introuvable. Prévenez le dispatcher.</Banner>
      </Screen>
    );
  }
  const a = d.article;
  const constat = d.type === 'CONSTAT';

  const onScan = (qr: string) => {
    if (qr !== a.qrCode) {
      feedback('error');
      setError('Ce n’est pas le bien demandé : vérifiez l’étiquette.');
      return;
    }
    feedback('ok');
    setError(null);
    setScanned(true);
  };

  const submit = async () => {
    for (const [i, p] of photos.entries()) await enqueuePhoto(p.photoId, p.blob, i === 0 ? 0 : 1);
    await enqueue({
      type: 'PHOTO_REQUEST_DONE',
      payload: { missionId, articleQr: a.qrCode, photoIds: photos.map((p) => p.photoId), etat: etat ?? undefined, commentaire: comment.trim() || undefined },
    });
    await markSet(key, true);
    setDone(true);
  };

  return (
    <Screen title={title} onBack={onBack}>
      <div className="request-card">
        <strong>{a.nomClient || a.libelle}</strong>
        {a.nomClient && <small>Au dépôt : {a.libelle}</small>}
        <small>
          {a.client} · {a.chemin ? a.chemin.split(' > ').slice(1).join(' › ') || a.chemin : 'Emplacement inconnu'}
        </small>
        {d.message && <p className="request-msg">« {d.message} »</p>}
      </div>

      {done ? (
        <Banner kind="ok">✓ Envoyé. Le client est prévenu dès que les photos sont arrivées au serveur.</Banner>
      ) : !scanned ? (
        <>
          {error && <Banner kind="error">{error}</Banner>}
          <Scanner expect={['A']} label="Scannez l’étiquette du bien" onScan={onScan} />
        </>
      ) : (
        <>
          <Banner kind="ok">✓ Bien identifié</Banner>
          <PhotoCapture photos={photos} onChange={setPhotos} min={1} max={6} label={constat ? 'Photos du constat' : 'Photos demandées'} />
          <Choice label={constat ? 'État constaté' : 'État'} value={etat} options={ARTICLE_CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABEL[c] }))} onChange={setEtat} />
          <label>
            {constat ? 'Constat pour le client' : 'Commentaire pour le client'}
            <textarea rows={3} value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} placeholder={constat ? 'Ex. rayure de 5 cm sur le plateau, pieds complets' : 'Facultatif'} />
          </label>
          <button type="button" className="btn primary big" disabled={!photos.length || (constat && !comment.trim())} onClick={() => void submit()}>
            Envoyer au client
          </button>
          {constat && !comment.trim() && <p className="hint">Un constat a besoin d’un commentaire.</p>}
        </>
      )}
    </Screen>
  );
}
