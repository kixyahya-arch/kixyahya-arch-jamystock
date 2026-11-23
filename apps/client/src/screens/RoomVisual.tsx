import { useEffect, useRef, useState } from 'react';
import { api, del, post } from '../lib/api';
import type { Ambiance } from '../lib/types';

/**
 * Visuel d'aménagement en tête d'une pièce de pack : généré par IA (Pollinations ou Higgsfield) à partir des meubles de la pièce,
 * ou image ajoutée à la main (photo de l'appartement témoin, rendu d'architecte). Il figure aussi sur la planche.
 */
export function RoomVisual({
  base,
  piece,
  ambiance,
  ia,
  restants,
  modifiable,
  photos = [],
  onChange,
}: {
  /** /me/cart-templates/:id */
  base: string;
  piece: string;
  ambiance: Ambiance | null;
  ia: boolean;
  restants: number | null;
  modifiable: boolean;
  /** photos des meubles de la pièce, pour les donner à un générateur d'images */
  photos?: { libelle: string; url: string }[];
  onChange: () => Promise<void> | void;
}) {
  const [kit, setKit] = useState(false);
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
          <button type="button" className="btn secondary small" aria-expanded={kit} onClick={() => setKit(!kit)}>
            {kit ? 'Fermer' : 'Préparer pour Higgsfield'}
          </button>
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
      {modifiable && kit && <HiggsfieldKit base={base} piece={piece} photos={photos} />}
      {error && <p className="small warn-text">{error}</p>}
    </div>
  );
}

/**
 * Prépare une génération dans Higgsfield (ou un autre générateur) avec l'abonnement du client : la description de
 * la scène à copier et les photos des meubles à déposer comme références ; l'image obtenue revient par « Ajouter
 * une image ».
 */
function HiggsfieldKit({ base, piece, photos }: { base: string; piece: string; photos: { libelle: string; url: string }[] }) {
  const [prompt, setPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    api<{ prompt: string }>(`${base}/ambiances/brief?piece=${encodeURIComponent(piece)}`)
      .then((r) => live && setPrompt(r.prompt))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [base, piece]);

  const copy = async () => {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setError('Copie impossible : sélectionnez le texte et copiez-le à la main');
    }
  };
  const slug = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

  return (
    <div className="room-kit">
      <ol className="small">
        <li>
          Copiez la description de la pièce et collez-la dans{' '}
          <a href="https://higgsfield.ai/image" target="_blank" rel="noreferrer">
            Higgsfield
          </a>
          .
        </li>
        <li>Téléchargez les photos des meubles et ajoutez-les comme images de référence.</li>
        <li>Générez l’image, enregistrez-la, puis revenez ici et cliquez sur « Ajouter une image ».</li>
      </ol>
      {error && <p className="small warn-text">{error}</p>}
      <textarea readOnly value={prompt ?? 'Préparation…'} rows={7} aria-label={`Description de la pièce ${piece}`} onFocus={(e) => e.currentTarget.select()} />
      <div className="row-actions">
        <button type="button" className="btn secondary small" disabled={!prompt} onClick={() => void copy()}>
          {copied ? 'Texte copié' : 'Copier le texte'}
        </button>
        <span className="hint small">{photos.length ? `${photos.length} photo${photos.length > 1 ? 's' : ''} de meubles` : 'Aucune photo de meuble dans cette pièce'}</span>
      </div>
      {photos.length > 0 && (
        <ul className="room-kit-photos">
          {photos.map((ph, i) => (
            <li key={`${ph.url}-${i}`}>
              <a href={ph.url} download={`${slug(piece)}-${i + 1}-${slug(ph.libelle)}.jpg`} title={`Télécharger la photo : ${ph.libelle}`}>
                <img src={ph.url} alt={ph.libelle} loading="lazy" />
                <span className="small">Télécharger</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
