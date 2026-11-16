import { useEffect, useState } from 'react';
import { get, post } from '../lib/api';
import { href } from '../lib/router';
import { EDITABLE, ORDER_STATUS, ORDER_TYPE, dateFr, type Ctx, type Order, type OrderSummary } from '../lib/types';
import { Banner, Pills, StatusPill } from '../components/ui';

const DONE = ['LIVREE', 'LIVREE_AVEC_RESERVES', 'RETIREE', 'STOCKEE', 'CLOTUREE', 'ANNULEE', 'REFUSEE'];
const tone = (s: string) => (s === 'EN_ATTENTE_VALIDATION' || s === 'EN_LIVRAISON' ? 'lime' : ['ANNULEE', 'REFUSEE', 'ECHEC_LIVRAISON'].includes(s) ? 'alert' : DONE.includes(s) ? 'neutral' : 'dark');

/** SUI-01 : suivi des commandes. */
export function Orders({ ctx }: { ctx: Ctx }) {
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [tab, setTab] = useState<'cours' | 'valider' | 'terminees'>('cours');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<OrderSummary[]>('/orders').then(setOrders, (e) => setError((e as Error).message));
  }, []);

  const toValidate = orders?.filter((o) => o.statut === 'EN_ATTENTE_VALIDATION') ?? [];
  const shown =
    orders?.filter((o) => (tab === 'valider' ? o.statut === 'EN_ATTENTE_VALIDATION' : tab === 'terminees' ? DONE.includes(o.statut) : !DONE.includes(o.statut))) ?? [];
  const project = (id: string | null) => ctx.projets.find((p) => p.id === id)?.nom;

  return (
    <>
      <section className="page-head">
        <span className="eyebrow">— Suivi</span>
        <h1>Mes commandes</h1>
      </section>
      <Pills
        label="Filtre"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'cours', label: 'En cours' },
          ...(toValidate.length ? [{ value: 'valider' as const, label: `À valider · ${toValidate.length}` }] : []),
          { value: 'terminees', label: 'Terminées' },
        ]}
      />
      {error && <Banner kind="error">{error}</Banner>}
      {!orders && !error && <p className="hint">Chargement…</p>}
      {orders && shown.length === 0 && <p className="empty">Aucune commande ici.</p>}
      <ul className="order-list">
        {shown.map((o) => (
          <li key={o.id}>
            <a href={href({ name: 'commande', id: o.id })}>
              <span className="order-main">
                <strong>{ORDER_TYPE[o.type]}</strong>
                <span className="mono">{o.numero}</span>
              </span>
              <span className="order-meta">
                {o.nbArticles} bien{o.nbArticles > 1 ? 's' : ''}
                {project(o.projetId) ? ` · ${project(o.projetId)}` : ''}
              </span>
              <span className="order-date">{o.dateConfirmee ? `Confirmée le ${dateFr(o.dateConfirmee)}` : `Souhaitée le ${dateFr(o.dateSouhaitee)}`}</span>
              <StatusPill label={ORDER_STATUS[o.statut] ?? o.statut} tone={tone(o.statut)} />
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

const STEPS: Record<string, string[]> = {
  LIVRAISON: ['SOUMISE', 'PLANIFIEE', 'EN_PREPARATION', 'EN_LIVRAISON', 'LIVREE'],
  RETRAIT: ['SOUMISE', 'PLANIFIEE', 'EN_PREPARATION', 'PRETE', 'RETIREE'],
  COLLECTE: ['SOUMISE', 'PLANIFIEE', 'COLLECTEE', 'STOCKEE'],
};

/** SUI-01, CMD-05, CMD-07, FLX-02 : détail, validation interne, annulation, réponse à une contre-proposition. */
export function OrderView({ id, role }: { id: string; role: string }) {
  const [o, setO] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [motif, setMotif] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);

  const load = () => get<Order>(`/orders/${id}`).then(setO, (e) => setError((e as Error).message));
  useEffect(() => void load(), [id]);

  const act = async (path: string, body: unknown = {}) => {
    setBusy(true);
    setError(null);
    try {
      await post(`/orders/${id}/${path}`, body);
      await load();
      setConfirmCancel(false);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  if (!o) return error ? <Banner kind="error">{error}</Banner> : <p className="hint">Chargement…</p>;
  const steps = STEPS[o.type] ?? [];
  const reachedAt = (s: string) => o.historique.find((h) => h.statut === s || (s === 'LIVREE' && h.statut === 'LIVREE_AVEC_RESERVES'))?.le;
  const currentIdx = steps.findIndex((s) => s === o.statut || (s === 'LIVREE' && o.statut === 'LIVREE_AVEC_RESERVES'));
  const canCancel = EDITABLE.includes(o.statut) || o.statut === 'PLANIFIEE';

  return (
    <>
      <a className="back-link" href={href({ name: 'commandes' })}>
        ← Mes commandes
      </a>
      <section className="page-head">
        <span className="eyebrow">
          — {ORDER_TYPE[o.type]} · <span className="mono">{o.numero}</span>
        </span>
        <h1>{ORDER_STATUS[o.statut] ?? o.statut}</h1>
      </section>

      {o.statut === 'EN_ATTENTE_VALIDATION' && role !== 'B2B_ADMIN' && (
        <Banner kind="info">Votre administrateur doit valider cette demande avant qu’elle soit transmise à JAMYSTOCK.</Banner>
      )}
      {o.statut === 'EN_ATTENTE_VALIDATION' && role === 'B2B_ADMIN' && (
        <div className="callout">
          <p>
            <strong>Cette demande attend votre validation</strong> avant d’être transmise à JAMYSTOCK.
          </p>
          <div className="row-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void act('approve')}>
              Valider
            </button>
            <input placeholder="Motif du refus" value={motif} onChange={(e) => setMotif(e.target.value)} />
            <button type="button" className="btn secondary" disabled={busy || motif.trim().length < 3} onClick={() => void act('reject', { motif: motif.trim() })}>
              Refuser
            </button>
          </div>
        </div>
      )}
      {o.dateContreProposee && !o.dateConfirmee && (
        <div className="callout">
          <p>
            JAMYSTOCK propose le <strong>{dateFr(o.dateContreProposee)}</strong> à la place du {dateFr(o.dateSouhaitee)}.
          </p>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void act('accept-date')}>
            Accepter cette date
          </button>
        </div>
      )}
      {o.motifRefus && <Banner kind="error">Refusée : {o.motifRefus}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}

      {steps.length > 0 && !['ANNULEE', 'REFUSEE'].includes(o.statut) && (
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={s} className={i < currentIdx ? 'done' : i === currentIdx ? 'current' : ''}>
              <span className="dot" />
              <strong>{ORDER_STATUS[s]}</strong>
              <small>{reachedAt(s) ? new Date(reachedAt(s)!).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : ''}</small>
            </li>
          ))}
        </ol>
      )}

      <div className="order-detail">
        <section>
          <h2>Biens</h2>
          <ul className="line-list">
            {o.lignes.map((l) => (
              <li key={l.id}>
                {l.articleId ? <a href={href({ name: 'article', id: l.articleId })}>{l.libelle}</a> : <span>{l.descriptionLibre}</span>}
                <small className="hint">{l.statutLigne === 'MANQUANTE' ? 'Introuvable au dépôt' : l.statutLigne === 'REFUSEE' ? 'Refusé à la livraison' : ''}</small>
              </li>
            ))}
          </ul>
        </section>
        <section className="facts">
          <h2>Détails</h2>
          <dl className="specs">
            <dt>Date</dt>
            <dd>{o.dateConfirmee ? `${dateFr(o.dateConfirmee)}${o.creneauConfirme ? `, ${o.creneauConfirme}` : ''} (confirmée)` : `${dateFr(o.dateSouhaitee)} (souhaitée)`}</dd>
            {o.adresse && (
              <>
                <dt>Adresse</dt>
                <dd>{o.adresse.libelle}</dd>
              </>
            )}
            {o.contactSite && (
              <>
                <dt>Contact</dt>
                <dd>
                  {o.contactSite.nom} · {o.contactSite.telephone}
                </dd>
              </>
            )}
            {o.type !== 'COLLECTE' && (
              <>
                <dt>Volume</dt>
                <dd>{o.volumeM3.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} m³</dd>
              </>
            )}
          </dl>
          {canCancel &&
            (confirmCancel ? (
              <div className="callout alert">
                <p>{o.statut === 'PLANIFIEE' ? 'La commande est déjà planifiée : des frais d’annulation tardive peuvent s’appliquer.' : 'Annuler cette commande ? Les biens restent au dépôt.'}</p>
                <div className="row-actions">
                  <button type="button" className="btn danger" disabled={busy} onClick={() => void act('cancel')}>
                    Confirmer l’annulation
                  </button>
                  <button type="button" className="btn secondary" onClick={() => setConfirmCancel(false)}>
                    Garder
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="btn secondary" onClick={() => setConfirmCancel(true)}>
                Annuler la commande
              </button>
            ))}
        </section>
      </div>
    </>
  );
}
