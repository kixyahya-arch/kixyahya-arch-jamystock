import { useEffect, useMemo, useState } from 'react';
import { api, get, post } from '../lib/api';
import { go } from '../lib/router';
import type { CollectionForecast, Ctx, Order } from '../lib/types';
import { Banner } from '../components/ui';
import { OBJECT_TYPES, estimate } from '../lib/volume';
import { shrinkPhoto } from '../lib/photos';

const MAX_PHOTOS = 10;
const fmt = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });

/**
 * CMD-06 : demande de collecte de nouveaux biens à faire entrer en stock. Volume estimé à la main ou avec
 * l'assistant par type d'objet, photos facultatives depuis le téléphone, et avertissement avant validation si la
 * collecte fera dépasser le forfait (RG-AL-03).
 */
export function Collection({ ctx, role }: { ctx: Ctx; role: string }) {
  const [projetId, setProjetId] = useState(ctx.projets[0]?.id ?? '');
  const [adresse, setAdresse] = useState('');
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [volume, setVolume] = useState('');
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [photos, setPhotos] = useState<File[]>([]);
  const [contact, setContact] = useState({ nom: '', telephone: '' });
  const [forecast, setForecast] = useState<CollectionForecast | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState<{ order: Order; failed: number } | null>(null);

  const est = useMemo(() => estimate(counts), [counts]);
  const previews = useMemo(() => photos.map((f) => URL.createObjectURL(f)), [photos]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);
  const summary = OBJECT_TYPES.filter((t) => (counts[t.key] ?? 0) > 0)
    .map((t) => `${counts[t.key]} × ${t.label.toLowerCase()}`)
    .join(', ');
  const text = description.trim() || summary;
  const ready = adresse.trim().length >= 3 && date && text && contact.nom.trim() && contact.telephone.trim().length >= 6 && (role !== 'B2B_USER' || projetId);

  // l'assistant remplit le volume ; une saisie à la main reste possible ensuite
  const setCount = (key: string, n: number) => {
    const next = { ...counts, [key]: Math.max(0, Math.min(999, n)) };
    setCounts(next);
    const e = estimate(next);
    setVolume(e.volumeM3 > 0 ? String(e.volumeM3) : '');
  };

  // RG-AL-03 : surface prévue après la collecte (emprise de l'assistant, sinon volume saisi)
  const vol = Number(volume) || 0;
  useEffect(() => {
    if (!est.m2 && !vol) {
      setForecast(null);
      return;
    }
    const q = est.m2 > 0 && Math.abs(est.volumeM3 - vol) < 0.05 ? `m2=${est.m2}` : `volume=${vol}`;
    const t = setTimeout(() => get<CollectionForecast>(`/me/collecte/prevision?${q}`).then(setForecast, () => setForecast(null)), 350);
    return () => clearTimeout(t);
  }, [est.m2, est.volumeM3, vol]);

  const addPhotos = (list: FileList | null) => {
    if (!list) return;
    // copie immédiate : la liste du champ est vidée juste après (pour pouvoir rechoisir la même photo)
    const picked = Array.from(list).filter((f) => f.type.startsWith('image/'));
    setPhotos((p) => [...p, ...picked].slice(0, MAX_PHOTOS));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const lignes = OBJECT_TYPES.filter((t) => (counts[t.key] ?? 0) > 0).map((t) => ({ description: t.label, quantite: counts[t.key]! }));
      const o = await post<Order>('/collections', {
        ...(projetId ? { projetId } : {}),
        adresse: { libelle: adresse.trim() },
        dateSouhaitee: date,
        description: text,
        ...(vol > 0 ? { volumeEstimeM3: vol } : {}),
        ...(lignes.length ? { lignes } : {}),
        contactSite: { nom: contact.nom.trim(), telephone: contact.telephone.trim() },
      });
      let failed = 0;
      for (const f of photos) {
        try {
          const blob = await shrinkPhoto(f);
          await api(`/collections/${o.id}/photos/${crypto.randomUUID()}`, { method: 'PUT', body: blob, headers: { 'Content-Type': blob.type || f.type } });
        } catch {
          failed++;
        }
      }
      if (failed) {
        setPartial({ order: o, failed });
        setBusy(false);
        return;
      }
      go({ name: 'commande', id: o.id });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  if (partial) {
    return (
      <section className="form-card narrow">
        <Banner kind="ok">Votre demande {partial.order.numero} est enregistrée.</Banner>
        <p>
          {partial.failed} photo{partial.failed > 1 ? 's n’ont' : ' n’a'} pas pu être envoyée{partial.failed > 1 ? 's' : ''} (connexion ou format). Vous pouvez les ajouter depuis la
          demande, tant que la collecte n’a pas eu lieu.
        </p>
        <button type="button" className="btn primary big" onClick={() => go({ name: 'commande', id: partial.order.id })}>
          Voir ma demande
        </button>
      </section>
    );
  }

  return (
    <>
      <section className="page-head">
        <span className="eyebrow">— Collecte</span>
        <h1>Faire entrer des biens en stock</h1>
        <p className="lead">Nous venons les chercher, chaque objet est photographié et étiqueté à son arrivée au dépôt, puis apparaît dans votre stock.</p>
      </section>
      <section className="form-card narrow">
        {ctx.projets.length > 0 && (
          <label>
            Projet
            <select value={projetId} onChange={(e) => setProjetId(e.target.value)}>
              {role !== 'B2B_USER' && <option value="">Sans projet</option>}
              {ctx.projets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nom}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Adresse d’enlèvement
          <input value={adresse} onChange={(e) => setAdresse(e.target.value)} placeholder="N°, rue, code postal, ville" autoComplete="street-address" />
        </label>
        <label>
          Date souhaitée
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>

        <details className="volume-helper" open={est.objets > 0 || undefined}>
          <summary>
            Estimer le volume par type d’objet
            {est.objets > 0 && (
              <span className="hint">
                {' '}
                · {est.objets} objet{est.objets > 1 ? 's' : ''}, ≈ {fmt(est.volumeM3)} m³
              </span>
            )}
          </summary>
          <ul className="object-types">
            {OBJECT_TYPES.map((t) => {
              const n = counts[t.key] ?? 0;
              return (
                <li key={t.key} className={n > 0 ? 'on' : ''}>
                  <span>
                    {t.label}
                    <small className="hint">
                      {t.dims.map((d) => fmt(d)).join(' × ')} m
                    </small>
                  </span>
                  <span className="stepper">
                    <button type="button" aria-label={`Retirer : ${t.label}`} disabled={n === 0} onClick={() => setCount(t.key, n - 1)}>
                      −
                    </button>
                    <input type="number" min={0} max={999} inputMode="numeric" aria-label={`Nombre : ${t.label}`} value={n || ''} placeholder="0" onChange={(e) => setCount(t.key, Number(e.target.value) || 0)} />
                    <button type="button" aria-label={`Ajouter : ${t.label}`} onClick={() => setCount(t.key, n + 1)}>
                      +
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
          {est.objets > 0 && (
            <p className="hint">
              Environ {fmt(est.volumeM3)} m³ à transporter et {fmt(est.m2)} m² au sol une fois rangés au dépôt. Dimensions moyennes : le volume exact est mesuré à l’arrivée.
            </p>
          )}
        </details>

        <label>
          Volume estimé (m³, facultatif)
          <input type="number" min={0.1} step={0.1} value={volume} onChange={(e) => setVolume(e.target.value)} />
        </label>
        <label>
          Que faut-il collecter ?
          <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={summary || 'Ex. : 12 chaises, 2 bureaux, 1 totem PLV'} />
        </label>
        {!description.trim() && summary && <p className="hint small">Sans précision de votre part, la liste de l’assistant sert de description.</p>}

        <div className="photo-field">
          <span className="label">Photos (facultatives, {MAX_PHOTOS} au plus)</span>
          <p className="hint small">Prises avec votre téléphone, elles aident à prévoir le bon véhicule et l’équipe.</p>
          {photos.length > 0 && (
            <ul className="photo-previews">
              {photos.map((f, i) => (
                <li key={`${f.name}-${i}`}>
                  <img src={previews[i]} alt={`Photo ${i + 1}`} />
                  <button type="button" aria-label={`Retirer la photo ${i + 1}`} onClick={() => setPhotos(photos.filter((_, j) => j !== i))}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {photos.length < MAX_PHOTOS && (
            <label className="btn secondary file-btn">
              {photos.length ? 'Ajouter des photos' : 'Prendre ou choisir des photos'}
              <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/*" multiple onChange={(e) => (addPhotos(e.target.files), (e.target.value = ''))} />
            </label>
          )}
        </div>

        <div className="two">
          <label>
            Contact sur place
            <input value={contact.nom} onChange={(e) => setContact({ ...contact, nom: e.target.value })} autoComplete="name" />
          </label>
          <label>
            Téléphone
            <input value={contact.telephone} onChange={(e) => setContact({ ...contact, telephone: e.target.value })} inputMode="tel" autoComplete="tel" />
          </label>
        </div>

        {forecast?.depasse && (
          <div className="banner warn" role="status">
            <strong>Cette collecte fera dépasser votre forfait.</strong>{' '}
            {forecast.m2Prevus !== undefined
              ? `Une fois rangés, vos biens occuperont environ ${fmt(forecast.m2Prevus)} m² pour ${fmt(forecast.m2Inclus!)} m² inclus${forecast.m2EnCours ? ` (collectes déjà demandées comprises)` : ''}, soit ${fmt(forecast.m2Depassement!)} m² facturés en dépassement au prorata.`
              : 'Vos administrateurs en seront prévenus. Le dépassement est facturé au prorata.'}{' '}
            Vous pouvez demander quand même, faire livrer d’autres biens, ou passer au forfait supérieur.
          </div>
        )}
        {forecast && !forecast.depasse && forecast.niveau === 'ATTENTION' && (
          <Banner kind="info">Après cette collecte, vous serez proche de votre forfait{forecast.m2Prevus !== undefined ? ` (${fmt(forecast.m2Prevus)} m² sur ${fmt(forecast.m2Inclus!)} m²)` : ''}.</Banner>
        )}
        {error && <Banner kind="error">{error}</Banner>}
        <button type="button" className="btn primary big" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? (photos.length ? 'Envoi des photos…' : 'Envoi…') : forecast?.depasse ? 'Demander la collecte malgré le dépassement' : 'Demander la collecte'}
        </button>
      </section>
    </>
  );
}
