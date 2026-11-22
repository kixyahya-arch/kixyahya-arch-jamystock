import { useRef, useState } from 'react';
import { api, del, post } from '../lib/api';
import type { Ambiance } from '../lib/types';

/**
 * Visuel d'aménagement en tête d'une pièce de pack : généré par IA (Higgsfield) à partir des meubles de la pièce,
 * ou image ajoutée à la main (photo de l'appartement témoin, rendu d'architecte). Il figure aussi sur la planche.
 */
export function RoomVisual({
  base,
  piece,
  ambiance,
  ia,
  restants,
  modifiable,
  onChange,
}: {
  /** /me/cart-templates/:id */
  base: string;
  piece: string;
  ambiance: Ambiance | null;
  ia: boolean;
  restants: number | null;
  modifiable: boolean;
  onChange: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const q = `?piece=${encodeURIComponent(piece)}`;
  const canGenerate = ia && (restants ?? 0) > 0;

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      await onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const generate = () => run(() => post(`${base}/ambiances/ia`, { piece }));
  const upload = (f: File | undefined) => {
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) return setError('Image trop lourde (8 Mo au maximum)');
    void run(() => api(`${base}/ambiances${q}`, { method: 'PUT', body: f, headers: { 'Content-Type': f.type || 'image/jpeg' } }));
  };
  const remove = () => {
    if (!window.confirm(`Retirer le visuel de la pièce « ${piece} » ?`)) return;
    void run(() => del(`${base}/ambiances${q}`));
  };

  if (!ambiance && !modifiable) return null;
  const pending = ambiance?.statut === 'EN_COURS';
  const quota = ia && restants !== null ? ` · ${restants} restant${restants > 1 ? 's' : ''} ce mois-ci` : '';

  return (
    <div className="room-visual">
      {ambiance?.statut === 'PRET' && ambiance.url && (
        <figure>
          <img src={ambiance.url} alt={`Visuel d’aménagement : ${piece}`} loading="lazy" />
          <figcaption className="hint small">{ambiance.source === 'IA' ? 'Visuel généré par IA à partir de vos meubles : l’aspect réel peut varier.' : 'Image ajoutée au pack.'}</figcaption>
        </figure>
      )}
      {pending && (
        <div className="room-visual-empty pending" role="status">
          <span className="spinner" aria-hidden="true" /> Visuel de la pièce en cours de génération, cela prend en général une à deux minutes.
        </div>
      )}
      {ambiance?.statut === 'ECHEC' && <p className="small warn-text">Le visuel n’a pas pu être généré : {ambiance.erreur ?? 'erreur inconnue'}.</p>}
      {!ambiance && modifiable && (
        <div className="room-visual-empty">
          <span className="hint small">
            {ia ? 'Aucun visuel pour cette pièce. Générez-en un à partir des meubles, ou ajoutez une image.' : 'Ajoutez une image de la pièce aménagée : elle figurera en tête de pièce sur la planche.'}
          </span>
        </div>
      )}
      {modifiable && !pending && (
        <div className="row-actions room-visual-actions">
          {ia && (
            <button type="button" className="btn secondary small" disabled={busy || !canGenerate} onClick={() => void generate()} title={canGenerate ? undefined : 'Plafond de visuels générés atteint pour ce mois-ci'}>
              {busy ? 'Envoi…' : ambiance?.statut === 'PRET' && ambiance.source === 'IA' ? 'Générer un autre visuel' : 'Générer le visuel (IA)'}
            </button>
          )}
          <button type="button" className="btn secondary small" disabled={busy} onClick={() => file.current?.click()}>
            {ambiance?.statut === 'PRET' ? 'Remplacer par une image' : 'Ajouter une image'}
          </button>
          {ambiance && (
            <button type="button" className="link danger-link" disabled={busy} onClick={remove}>
              Retirer le visuel
            </button>
          )}
          <span className="hint small">{quota.replace(/^ · /, '')}</span>
          <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => (upload(e.target.files?.[0]), (e.target.value = ''))} />
        </div>
      )}
      {error && <p className="small warn-text">{error}</p>}
    </div>
  );
}
