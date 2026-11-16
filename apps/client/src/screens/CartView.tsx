import { useState } from 'react';
import { post } from '../lib/api';
import { refreshCart, removeFromCart, useCarts } from '../lib/cart';
import { go, href } from '../lib/router';
import { euros, dateFr, type Cart, type Ctx, type Order } from '../lib/types';
import { Banner, Pills } from '../components/ui';

/** CMD-01 à CMD-05 : panier, livraison ou retrait, adresse et contraintes d'accès, estimation, envoi. */
export function CartView({ ctx, role }: { ctx: Ctx; role: string }) {
  const { carts, loaded } = useCarts();
  const filled = Object.entries(carts).filter(([, c]) => c.nbArticles > 0);
  const [key, setKey] = useState<string | null>(null);
  const selected = filled.find(([k]) => k === key) ?? filled[0];
  const projectName = (k: string) => (k ? (ctx.projets.find((p) => p.id === k)?.nom ?? 'Projet') : 'Sans projet');

  if (!loaded) return <p className="hint">Chargement…</p>;
  return (
    <>
      <section className="page-head">
        <span className="eyebrow">— Panier</span>
        <h1>Récupérer mes biens</h1>
        <p className="lead">Choisissez la livraison sur site ou le retrait au dépôt. Nous confirmons la date sous 24 h ouvrées.</p>
      </section>
      {!selected && (
        <div className="empty-block">
          <p>Votre panier est vide.</p>
          <a className="btn primary" href={href({ name: 'inventaire' })}>
            Parcourir mon stock
          </a>
        </div>
      )}
      {filled.length > 1 && (
        <Pills label="Paniers par projet" value={selected![0]} onChange={setKey} options={filled.map(([k, c]) => ({ value: k, label: `${projectName(k)} · ${c.nbArticles}` }))} />
      )}
      {selected && <Checkout key={selected[0]} projetId={selected[0] || null} cart={selected[1]} role={role} />}
    </>
  );
}

function Checkout({ projetId, cart, role }: { projetId: string | null; cart: Cart; role: string }) {
  const est = cart.estimation;
  const [type, setType] = useState<'LIVRAISON' | 'RETRAIT'>('LIVRAISON');
  const [adresse, setAdresse] = useState('');
  const [date, setDate] = useState(est.datePlusTot);
  const [creneau, setCreneau] = useState('Matin (8 h – 12 h)');
  const [contact, setContact] = useState({ nom: '', telephone: '' });
  const [etage, setEtage] = useState('');
  const [ascenseur, setAscenseur] = useState(false);
  const [accesPL, setAccesPL] = useState(true);
  const [consignes, setConsignes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const delivery = type === 'LIVRAISON';
  const included = delivery && est.livraisonsIncluseRestantes > 0;
  const price = delivery ? (included ? 0 : (est.livraison?.prixHtCents ?? null)) : est.retraitHtCents;
  const needsApproval = role === 'B2B_USER';
  const blocked = cart.lignes.some((l) => l.disponible === false);
  const ready = !blocked && date && (!delivery || (adresse.trim().length >= 3 && contact.nom.trim() && contact.telephone.trim().length >= 6));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const order = await post<Order>(`/orders/${cart.id}/submit`, {
        type,
        dateSouhaitee: date,
        creneau,
        ...(delivery
          ? {
              adresse: { libelle: adresse.trim() },
              contactSite: { nom: contact.nom.trim(), telephone: contact.telephone.trim() },
              contraintesAcces: {
                ...(etage ? { etage: Number(etage) } : {}),
                ...(ascenseur ? {} : { ascenseur: null }),
                accesPL,
                ...(consignes.trim() ? { consignes: consignes.trim() } : {}),
              },
            }
          : {}),
      });
      await refreshCart(projetId);
      go({ name: 'commande', id: order.id });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="checkout">
      <section className="lines">
        <h2>
          {cart.nbArticles} bien{cart.nbArticles > 1 ? 's' : ''}
        </h2>
        <ul className="line-list">
          {cart.lignes.map((l) => (
            <li key={l.id} className={l.disponible === false ? 'unavailable' : ''}>
              <span>
                <a href={href({ name: 'article', id: l.articleId! })}>{l.libelle}</a>
                {l.disponible === false && <small className="tag-alert">Plus disponible : déjà dans une autre commande</small>}
              </span>
              <button type="button" className="link" onClick={() => void removeFromCart(l.articleId!, projetId)}>
                Retirer
              </button>
            </li>
          ))}
        </ul>
        <div className="estimate">
          <div>
            <span className="eyebrow">Volume</span>
            <strong>{cart.volumeM3.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} m³</strong>
          </div>
          <div>
            <span className="eyebrow">Véhicule pressenti</span>
            <strong>{delivery ? (cart.vehiculeSuggere ?? 'À définir') : '—'}</strong>
          </div>
          <div>
            <span className="eyebrow">Coût estimé</span>
            <strong>{price === null ? 'Sur devis' : price === 0 ? (delivery ? 'Inclus au forfait' : 'Gratuit') : `${euros(price)} HT`}</strong>
          </div>
        </div>
        {delivery && est.livraisonsIncluses > 0 && (
          <p className="hint">
            Votre forfait inclut {est.livraisonsIncluses} livraison{est.livraisonsIncluses > 1 ? 's' : ''} par mois ; il en reste {est.livraisonsIncluseRestantes} ce mois-ci.
          </p>
        )}
      </section>

      <section className="form-card">
        <Pills
          label="Mode de récupération"
          value={type}
          onChange={setType}
          options={[
            { value: 'LIVRAISON', label: 'Livraison sur site' },
            { value: 'RETRAIT', label: 'Retrait au dépôt' },
          ]}
        />
        {delivery && (
          <>
            <label>
              Adresse de livraison
              <input value={adresse} onChange={(e) => setAdresse(e.target.value)} placeholder="N°, rue, code postal, ville" autoComplete="street-address" />
            </label>
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
          </>
        )}
        <div className="two">
          <label>
            Date souhaitée
            <input type="date" min={est.datePlusTot} value={date} onChange={(e) => setDate(e.target.value)} />
            <small className="hint">Au plus tôt le {dateFr(est.datePlusTot)}.</small>
          </label>
          <label>
            Créneau
            <select value={creneau} onChange={(e) => setCreneau(e.target.value)}>
              <option>Matin (8 h – 12 h)</option>
              <option>Après-midi (13 h – 17 h)</option>
              <option>Journée</option>
            </select>
          </label>
        </div>
        {delivery && (
          <fieldset className="constraints">
            <legend>Accès au site</legend>
            <div className="two">
              <label>
                Étage
                <input type="number" min={-3} max={60} value={etage} onChange={(e) => setEtage(e.target.value)} placeholder="0 = rez-de-chaussée" />
              </label>
              <div className="checks">
                <label className="check">
                  <input type="checkbox" checked={ascenseur} onChange={(e) => setAscenseur(e.target.checked)} /> Ascenseur disponible
                </label>
                <label className="check">
                  <input type="checkbox" checked={accesPL} onChange={(e) => setAccesPL(e.target.checked)} /> Accès poids lourd
                </label>
              </div>
            </div>
            <label>
              Consignes (horaires du chantier, badge, stationnement…)
              <textarea rows={3} value={consignes} onChange={(e) => setConsignes(e.target.value)} />
            </label>
          </fieldset>
        )}
        {blocked && <Banner kind="error">Retirez du panier les biens qui ne sont plus disponibles.</Banner>}
        {error && <Banner kind="error">{error}</Banner>}
        <button type="button" className="btn primary big" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? 'Envoi…' : 'Envoyer la demande'}
        </button>
        {needsApproval && <p className="hint">Selon vos droits sur ce projet, la demande peut d’abord passer par la validation de votre administrateur.</p>}
      </section>
    </div>
  );
}
