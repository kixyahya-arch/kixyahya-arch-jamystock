import { useState } from 'react';
import { post } from '../lib/api';
import { go } from '../lib/router';
import type { Ctx, Order } from '../lib/types';
import { Banner } from '../components/ui';

/** CMD-06 : demande de collecte de nouveaux biens à faire entrer en stock. */
export function Collection({ ctx, role }: { ctx: Ctx; role: string }) {
  const [projetId, setProjetId] = useState(ctx.projets[0]?.id ?? '');
  const [adresse, setAdresse] = useState('');
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [volume, setVolume] = useState('');
  const [contact, setContact] = useState({ nom: '', telephone: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = adresse.trim().length >= 3 && date && description.trim() && contact.nom.trim() && contact.telephone.trim().length >= 6 && (role !== 'B2B_USER' || projetId);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const o = await post<Order>('/collections', {
        ...(projetId ? { projetId } : {}),
        adresse: { libelle: adresse.trim() },
        dateSouhaitee: date,
        description: description.trim(),
        ...(volume ? { volumeEstimeM3: Number(volume) } : {}),
        contactSite: { nom: contact.nom.trim(), telephone: contact.telephone.trim() },
      });
      go({ name: 'commande', id: o.id });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

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
          <input value={adresse} onChange={(e) => setAdresse(e.target.value)} placeholder="N°, rue, code postal, ville" />
        </label>
        <div className="two">
          <label>
            Date souhaitée
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            Volume estimé (m³, facultatif)
            <input type="number" min={0.1} step={0.1} value={volume} onChange={(e) => setVolume(e.target.value)} />
          </label>
        </div>
        <label>
          Que faut-il collecter ?
          <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ex. : 12 chaises, 2 bureaux, 1 totem PLV" />
        </label>
        <div className="two">
          <label>
            Contact sur place
            <input value={contact.nom} onChange={(e) => setContact({ ...contact, nom: e.target.value })} />
          </label>
          <label>
            Téléphone
            <input value={contact.telephone} onChange={(e) => setContact({ ...contact, telephone: e.target.value })} inputMode="tel" />
          </label>
        </div>
        {error && <Banner kind="error">{error}</Banner>}
        <button type="button" className="btn primary big" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? 'Envoi…' : 'Demander la collecte'}
        </button>
      </section>
    </>
  );
}
