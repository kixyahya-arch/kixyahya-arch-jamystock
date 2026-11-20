import { useEffect, useState } from 'react';
import { api, get, getSession, listen, post } from '../lib/api';
import { href } from '../lib/router';
import { EDITABLE, ORDER_STATUS, ORDER_TYPE, dateFr, euros, type Ctx, type Delivery, type Dispute, type Order, type OrderSummary } from '../lib/types';
import { Banner, Pills, StatusPill, type Tone } from '../components/ui';

const DONE = ['LIVREE', 'LIVREE_AVEC_RESERVES', 'RETIREE', 'STOCKEE', 'CLOTUREE', 'ANNULEE', 'REFUSEE'];
/** Couleurs fonctionnelles de la charte : en préparation (azur éclairci), en livraison (azur plein), livré (vert), stocké (encre). */
const tone = (s: string): Tone =>
  s === 'EN_LIVRAISON'
    ? 'route'
    : ['REFUSEE', 'ECHEC_LIVRAISON'].includes(s)
      ? 'alert'
      : s === 'STOCKEE'
        ? 'dark'
        : s === 'ANNULEE' || s === 'BROUILLON'
          ? 'neutral'
          : DONE.includes(s)
            ? 'ok'
            : 'accent';

/** SUI-01 : suivi des commandes. */
export function Orders({ ctx }: { ctx: Ctx }) {
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [tab, setTab] = useState<'cours' | 'valider' | 'terminees'>('cours');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () => get<OrderSummary[]>('/orders').then(setOrders, (e) => setError((e as Error).message));
    // SUI-01 : la liste se met à jour d'elle-même quand une commande change de statut
    const stop = listen('/orders-events', () => void load());
    void load();
    return stop;
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
  useEffect(() => {
    void load();
    // SUI-01 : la frise avance en direct, sans rechargement
    return listen(`/orders/${id}/events`, () => void load());
  }, [id]);

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
  const steps = o.natureCollecte === 'TRANSFERT' ? ['SOUMISE', 'PLANIFIEE', 'COLLECTEE', 'LIVREE'] : (STEPS[o.type] ?? []);
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

      {o.suivi && !['LIVREE', 'LIVREE_AVEC_RESERVES', 'STOCKEE', 'ANNULEE'].includes(o.statut) && (
        <div className="callout track-callout">
          <p>
            <strong>{o.type === 'COLLECTE' ? 'Le chauffeur est en route pour la collecte.' : 'Le chauffeur est en route.'}</strong> Suivez sa position et l’heure d’arrivée estimée ; vous pouvez
            transmettre ce lien à la personne sur place, il fonctionne sans compte.
          </p>
          <div className="row-actions">
            <a className="btn primary" href={href({ name: 'suivi', token: o.suivi.jeton })} target="_blank" rel="noreferrer">
              Suivre le chauffeur
            </a>
            <button type="button" className="btn secondary" onClick={() => void navigator.clipboard?.writeText(`${location.origin}${location.pathname}${href({ name: 'suivi', token: o.suivi!.jeton })}`)}>
              Copier le lien
            </button>
          </div>
        </div>
      )}

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
                <small className="hint">
                  {l.statutLigne === 'MANQUANTE' ? (o.type === 'COLLECTE' ? 'Introuvable sur place' : 'Introuvable au dépôt') : l.statutLigne === 'REFUSEE' ? 'Refusé à la livraison' : ''}
                </small>
              </li>
            ))}
          </ul>
        </section>
        <section className="facts">
          <h2>Détails</h2>
          <dl className="specs">
            <dt>Date</dt>
            <dd>{o.dateConfirmee ? `${dateFr(o.dateConfirmee)}${o.creneauConfirme ? `, ${o.creneauConfirme}` : ''} (confirmée)` : `${dateFr(o.dateSouhaitee)} (souhaitée)`}</dd>
            {o.natureCollecte && o.natureCollecte !== 'NOUVEAUX' && (
              <>
                <dt>Nature</dt>
                <dd>{o.natureCollecte === 'RETOUR' ? 'Retour au dépôt d’objets installés sur site' : 'Transfert vers un autre site'}</dd>
              </>
            )}
            {o.adresse && (
              <>
                <dt>{o.natureCollecte === 'TRANSFERT' ? 'Reprise à' : 'Adresse'}</dt>
                <dd>{o.adresse.libelle}</dd>
              </>
            )}
            {o.destination && (
              <>
                <dt>Destination</dt>
                <dd>{o.destination.libelle}</dd>
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
            {o.type === 'LIVRAISON' && (
              <>
                <dt>Si personne n’est là</dt>
                <dd>{o.depotSansSignature ? 'Dépôt sans signature autorisé' : 'Retour au dépôt'}</dd>
              </>
            )}
            {o.type !== 'COLLECTE' && (
              <>
                <dt>Volume</dt>
                <dd>{o.volumeM3.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} m³</dd>
              </>
            )}
          </dl>
          {o.type !== 'COLLECTE' && ['LIVREE', 'LIVREE_AVEC_RESERVES', 'RETIREE'].includes(o.statut) && <AfterDelivery orderId={o.id} />}
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

const MOTIF: Record<Dispute['motif'], string> = { CASSE: 'Bien cassé', RAYURE: 'Rayure ou salissure', MANQUANT: 'Bien manquant', ERREUR: 'Erreur de bien', AUTRE: 'Autre problème' };
const DISPUTE_STATUS: Record<Dispute['statut'], string> = { OUVERT: 'Reçu', EN_COURS: 'Pris en charge', RESOLU: 'Résolu', REJETE: 'Non retenu' };

/** LIV-05 et SUI-04 : remise (BL, dépôt sans signature et ses photos) et signalement d'un problème dans les 48 h. */
function AfterDelivery({ orderId }: { orderId: string }) {
  const [d, setD] = useState<Delivery | null>(null);
  const [open, setOpen] = useState(false);
  const load = () => get<Delivery>(`/me/disputes/delivery/${orderId}`).then(setD, () => setD(null));
  useEffect(() => void load(), [orderId]);
  if (!d?.livraison) return null;
  const l = d.livraison;
  const pending = d.litiges.find((x) => x.statut === 'OUVERT' || x.statut === 'EN_COURS');
  const readOnly = !!getSession()?.support;

  return (
    <section className="after-delivery">
      <h2>Remise</h2>
      {l.nonSigne ? (
        <div className="callout">
          <p>
            <strong>Déposé sans signature</strong> le {l.le ? new Date(l.le).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' }) : ''}, comme vous l’aviez autorisé.
          </p>
          {l.lieuDepot && <p className="hint">Lieu du dépôt : {l.lieuDepot}</p>}
        </div>
      ) : (
        <p className="hint">
          Bon de livraison <span className="mono">{l.numero}</span> signé{l.signataire ? ` par ${l.signataire}` : ''}
          {l.le ? ` le ${new Date(l.le).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' })}` : ''}.
        </p>
      )}
      {l.photos.length > 0 && (
        <div className="photo-row">
          {l.photos.map((p) => (
            <a key={p.id} href={p.originale} target="_blank" rel="noreferrer">
              <img src={p.vignette} alt="Photo du dépôt" />
            </a>
          ))}
        </div>
      )}

      {d.litiges.map((x) => (
        <article key={x.id} className="dispute">
          <div className="dispute-head">
            <strong>
              {MOTIF[x.motif]} · <span className="mono">{x.numero}</span>
            </strong>
            <StatusPill label={DISPUTE_STATUS[x.statut]} tone={x.statut === 'RESOLU' ? 'ok' : x.statut === 'REJETE' ? 'alert' : 'accent'} />
          </div>
          <p>{x.description}</p>
          {x.articles.length > 0 && <small className="hint">Biens concernés : {x.articles.map((a) => a.libelle).join(', ')}</small>}
          {x.photos.length > 0 && (
            <div className="photo-row">
              {x.photos.map((p) => (
                <a key={p.id} href={p.originale} target="_blank" rel="noreferrer">
                  <img src={p.vignette} alt="Photo jointe" />
                </a>
              ))}
            </div>
          )}
          {x.reponse && (
            <p className="dispute-answer">
              <strong>Réponse de JAMYSTOCK :</strong> {x.reponse}
              {x.gesteCents ? ` Geste commercial de ${euros(x.gesteCents)} HT, déduit de votre prochaine facture.` : ''}
            </p>
          )}
        </article>
      ))}

      {l.signalementPossible && !pending && !readOnly &&
        (open ? (
          <DisputeForm orderId={orderId} articles={l.articles} onDone={() => (setOpen(false), void load())} onCancel={() => setOpen(false)} />
        ) : (
          <>
            <button type="button" className="btn secondary" onClick={() => setOpen(true)}>
              Signaler un problème
            </button>
            <p className="hint small">Possible jusqu’au {l.signalementJusquau ? new Date(l.signalementJusquau).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' }) : ''}.</p>
          </>
        ))}
      {!l.signalementPossible && !d.litiges.length && <p className="hint small">Le délai de 48 heures pour signaler un problème en ligne est passé : contactez-nous directement.</p>}
    </section>
  );
}

function DisputeForm({ orderId, articles, onDone, onCancel }: { orderId: string; articles: { id: string; libelle: string }[]; onDone: () => void; onCancel: () => void }) {
  const [motif, setMotif] = useState<Dispute['motif']>('CASSE');
  const [description, setDescription] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ id: string; numero: string }>('/me/disputes', { commandeId: orderId, motif, description: description.trim(), articleIds: [...chosen] });
      for (const f of files) {
        await api(`/me/disputes/${r.id}/photos/${crypto.randomUUID()}`, { method: 'PUT', body: f, headers: { 'Content-Type': f.type } });
      }
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <form
      className="form-card dispute-form"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <h3>Signaler un problème</h3>
      <label>
        Nature du problème
        <select value={motif} onChange={(e) => setMotif(e.target.value as Dispute['motif'])}>
          {Object.entries(MOTIF).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      {articles.length > 0 && (
        <fieldset className="checks">
          <legend>Biens concernés</legend>
          {articles.map((a) => (
            <label key={a.id} className="check">
              <input
                type="checkbox"
                checked={chosen.has(a.id)}
                onChange={(e) => {
                  const n = new Set(chosen);
                  if (e.target.checked) n.add(a.id);
                  else n.delete(a.id);
                  setChosen(n);
                }}
              />{' '}
              {a.libelle}
            </label>
          ))}
        </fieldset>
      )}
      <label>
        Ce qui s’est passé
        <textarea rows={4} value={description} maxLength={3000} onChange={(e) => setDescription(e.target.value)} placeholder="Ex. un pied de chaise est cassé, constaté au déballage" />
      </label>
      <label>
        Photos (6 au plus, JPEG ou PNG)
        <input type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 6))} />
      </label>
      {files.length > 0 && <small className="hint">{files.length} photo{files.length > 1 ? 's' : ''} jointe{files.length > 1 ? 's' : ''}</small>}
      {error && <Banner kind="error">{error}</Banner>}
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={busy || description.trim().length < 10}>
          {busy ? 'Envoi…' : 'Envoyer le signalement'}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}
