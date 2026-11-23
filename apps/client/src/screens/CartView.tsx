import { useEffect, useState } from 'react';
import { del, get, post } from '../lib/api';
import { refreshCart, removeFromCart, useCarts } from '../lib/cart';
import { go, href } from '../lib/router';
import { euros, dateFr, type Cart, type CartTemplate, type Ctx, type Order } from '../lib/types';
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
      <Templates projectName={projectName} />
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
  const [sansSignature, setSansSignature] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const delivery = type === 'LIVRAISON';
  const included = delivery && est.livraisonsIncluseRestantes > 0;
  const price = delivery ? (included ? 0 : (est.livraison?.prixHtCents ?? null)) : est.retraitHtCents;
  const needsApproval = role === 'B2B_USER';
  const blocked = cart.lignes.some((l) => l.disponible === false);
  const ready = !blocked && date && (!delivery || (adresse.trim().length >= 3 && contact.nom.trim() && contact.telephone.trim().length >= 6));
  // ce qui manque pour envoyer, affiché sous le bouton tant qu'il est grisé
  const manque = [
    !date && 'la date souhaitée',
    delivery && adresse.trim().length < 3 && 'l’adresse de livraison',
    delivery && !contact.nom.trim() && 'le contact sur place',
    delivery && contact.telephone.trim().length < 6 && 'son téléphone',
  ].filter((x): x is string => !!x);

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
              depotSansSignature: sansSignature,
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
                {!!l.umTotal && l.umTotal > 1 && (
                  <small className="hint">Rangé sur une palette de {l.umTotal} biens : nous sortons seulement ceux de votre panier, le reste reste au dépôt.</small>
                )}
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
        <SaveTemplate projetId={projetId} />
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
            <label className="check absent">
              <input type="checkbox" checked={sansSignature} onChange={(e) => setSansSignature(e.target.checked)} />
              <span>
                Dépôt sans signature si personne n’est là
                <small className="hint">Le chauffeur dépose les biens à l’endroit indiqué dans les consignes et prend au moins 3 photos. Le bon de livraison est marqué « non signé, déposé ». Sinon, les biens reviennent au dépôt.</small>
              </span>
            </label>
          </fieldset>
        )}
        {blocked && <Banner kind="error">Retirez du panier les biens qui ne sont plus disponibles.</Banner>}
        {error && <Banner kind="error">{error}</Banner>}
        <button type="button" className="btn primary big" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? 'Envoi…' : 'Envoyer la demande'}
        </button>
        {!blocked && manque.length > 0 && <p className="hint small">À compléter : {manque.join(', ')}.</p>}
        {needsApproval && <p className="hint">Selon vos droits sur ce projet, la demande peut d’abord passer par la validation de votre administrateur.</p>}
      </section>
    </div>
  );
}

/** CMD-08 : enregistrer le panier comme pack (« Appartement témoin T3 »). */
function SaveTemplate({ projetId }: { projetId: string | null }) {
  const [open, setOpen] = useState(false);
  const [nom, setNom] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    setBusy(true);
    try {
      await post('/me/cart-templates', { nom: nom.trim(), ...(projetId ? { projetId } : {}) });
      setMsg({ ok: true, text: `Pack « ${nom.trim()} » enregistré : retrouvez-le dans Mes packs, pour le ranger pièce par pièce.` });
      setOpen(false);
      setNom('');
      window.dispatchEvent(new Event('jamystock:templates'));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="save-template">
      {open ? (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            Nom du pack
            <input value={nom} onChange={(e) => setNom(e.target.value)} maxLength={80} placeholder="Ex. Appartement témoin T3" autoFocus />
          </label>
          <button type="submit" className="btn primary small" disabled={busy || !nom.trim()}>
            {busy ? '…' : 'Enregistrer'}
          </button>
          <button type="button" className="btn ghost small" onClick={() => setOpen(false)}>
            Annuler
          </button>
        </form>
      ) : (
        <button type="button" className="link" onClick={() => (setOpen(true), setMsg(null))}>
          Enregistrer ce panier comme pack
        </button>
      )}
      {msg && <Banner kind={msg.ok ? 'ok' : 'error'}>{msg.text}</Banner>}
    </div>
  );
}

/** CMD-08 : packs enregistrés, à remettre au panier en un clic ; les biens indisponibles sont signalés. */
function Templates({ projectName }: { projectName: (k: string) => string }) {
  const [items, setItems] = useState<CartTemplate[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<{ kind: 'ok' | 'error' | 'info'; text: string; details?: string[] } | null>(null);
  const load = () => get<{ items: CartTemplate[] }>('/me/cart-templates').then((r) => setItems(r.items), () => setItems([]));
  useEffect(() => {
    void load();
    const on = () => void load();
    window.addEventListener('jamystock:templates', on);
    return () => window.removeEventListener('jamystock:templates', on);
  }, []);
  if (!items?.length) return null;

  const use = async (m: CartTemplate) => {
    setBusy(m.id);
    setReport(null);
    try {
      const r = await post<{ ajoutes: number; indisponibles: { libelle: string; raison: string }[]; projetId: string | null }>(`/me/cart-templates/${m.id}/use`);
      await refreshCart(r.projetId);
      setReport({
        kind: r.indisponibles.length ? 'info' : 'ok',
        text: `${r.ajoutes} bien${r.ajoutes > 1 ? 's' : ''} ajouté${r.ajoutes > 1 ? 's' : ''} au panier depuis « ${m.nom} ».${r.indisponibles.length ? ` ${r.indisponibles.length} indisponible${r.indisponibles.length > 1 ? 's' : ''} :` : ''}`,
        details: r.indisponibles.map((x) => `${x.libelle} : ${x.raison}`),
      });
      await load();
    } catch (e) {
      setReport({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const remove = async (m: CartTemplate) => {
    setBusy(m.id);
    try {
      await del(`/me/cart-templates/${m.id}`);
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="templates">
      <h2>Mes packs</h2>
      <p className="hint">
        Un pack remet en un clic le même ensemble de biens au panier. <a href={href({ name: 'packs' })}>Tous mes packs</a>
      </p>
      {report && (
        <Banner kind={report.kind}>
          {report.text}
          {!!report.details?.length && (
            <ul className="report-list">
              {report.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}
      <ul className="template-list">
        {items.map((m) => (
          <li key={m.id}>
            <span className="template-main">
              <a href={href({ name: 'pack', id: m.id })}>
                <strong>{m.nom}</strong>
              </a>
              <small>
                {projectName(m.projetId ?? '')} · {m.nbDisponibles === m.nbArticles ? `${m.nbArticles} bien${m.nbArticles > 1 ? 's' : ''}, tous disponibles` : `${m.nbDisponibles} sur ${m.nbArticles} disponibles`}
                {m.auteur ? ` · créé par ${m.auteur}` : ''}
              </small>
            </span>
            <span className="row-actions">
              <button type="button" className="btn primary small" disabled={!!busy || m.nbDisponibles === 0} onClick={() => void use(m)}>
                {busy === m.id ? '…' : 'Ajouter au panier'}
              </button>
              {m.supprimable && (
                <button type="button" className="link" disabled={!!busy} onClick={() => void remove(m)}>
                  Supprimer
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
