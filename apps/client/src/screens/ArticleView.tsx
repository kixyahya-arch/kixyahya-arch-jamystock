import { useEffect, useState } from 'react';
import { get, getSession, post, put } from '../lib/api';
import { addToCart, useCarts } from '../lib/cart';
import { href } from '../lib/router';
import { ARTICLE_STATUS, CONDITION, MOVE_TYPE, dateFr, type ArticleDetail, type ArticleRequest } from '../lib/types';
import { Banner, StatusPill } from '../components/ui';

const m = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('fr-FR')} m`);

/** INV-02 : fiche d'un bien, photos HD, caractéristiques, localisation et historique des mouvements. */
export function ArticleView({ id, canOrder }: { id: string; canOrder: boolean }) {
  const [a, setA] = useState<ArticleDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  const { inCart } = useCarts();

  useEffect(() => {
    get<ArticleDetail>(`/articles/${id}`).then(setA, (e) => setError((e as Error).message));
  }, [id]);

  if (error) return <Banner kind="error">{error}</Banner>;
  if (!a) return <p className="hint">Chargement…</p>;

  const photos = a.photos.filter((p) => p.disponible);
  const shown = photos[current];
  const taken = inCart.has(a.id);
  const engaged = a.statut !== 'EN_STOCK';

  return (
    <>
      <a className="back-link" href={href({ name: 'inventaire' })}>
        ← Mon stock
      </a>
      <div className="article">
        <section className="gallery">
          {shown ? (
            <a href={shown.originale} target="_blank" rel="noreferrer" className="gallery-main" title="Ouvrir la photo en haute définition">
              <img src={shown.moyenne} alt={a.libelle} />
            </a>
          ) : (
            <div className="gallery-main empty">Photo à venir</div>
          )}
          {photos.length > 1 && (
            <div className="gallery-strip">
              {photos.map((p, i) => (
                <button key={p.id} type="button" className={i === current ? 'active' : ''} onClick={() => setCurrent(i)} aria-label={`Photo ${i + 1}`}>
                  <img src={p.vignette} alt="" />
                </button>
              ))}
            </div>
          )}
          {a.photos.length > photos.length && <p className="hint">{a.photos.length - photos.length} photo(s) en cours d’envoi depuis le dépôt.</p>}
        </section>

        <section className="article-info">
          <span className="eyebrow">— {a.categorie_client ?? a.categorie ?? 'Bien'}{a.projet ? ` · ${a.projet}` : ''}</span>
          <h1>{a.nom_client || a.libelle}</h1>
          {a.nom_client && <p className="hint">Désignation au dépôt : {a.libelle}</p>}
          {a.reference_interne && <p className="ref-line">Réf. interne <span className="mono">{a.reference_interne}</span></p>}
          <div className="status-row">
            <StatusPill label={ARTICLE_STATUS[a.statut] ?? a.statut} tone={engaged ? 'dark' : 'accent'} />
            <StatusPill label={CONDITION[a.etat] ?? a.etat} />
          </div>
          {a.description && <p>{a.description}</p>}
          <dl className="specs">
            <dt>Dimensions (L × l × h)</dt>
            <dd>
              {m(a.longueur_m)} × {m(a.largeur_m)} × {m(a.hauteur_m)}
            </dd>
            {a.poids_kg !== null && (
              <>
                <dt>Poids</dt>
                <dd>{a.poids_kg} kg</dd>
              </>
            )}
            {a.couleur && (
              <>
                <dt>Couleur</dt>
                <dd>{a.couleur}</dd>
              </>
            )}
            <dt>Empilable</dt>
            <dd>{a.empilable ? 'Oui' : 'Non'}</dd>
            <dt>Entré au dépôt</dt>
            <dd>{dateFr(a.date_entree)}</dd>
            <dt>Emplacement</dt>
            <dd>{a.statut === 'RESTITUE' ? `Sur site${a.projet ? ` : ${a.projet}` : ''}` : (a.localisation ?? '—')}</dd>
            <dt>Étiquette</dt>
            <dd className="mono">{a.qr_code}</dd>
          </dl>
          {canOrder && !engaged && (
            <button type="button" className="btn primary big" disabled={taken} onClick={() => void addToCart(a.id, a.projet_id).catch((e) => setError((e as Error).message))}>
              {taken ? 'Dans le panier ✓' : 'Ajouter au panier'}
            </button>
          )}
          {taken && (
            <a className="link-arrow" href={href({ name: 'panier' })}>
              Voir le panier ↗
            </a>
          )}

          <Annotation a={a} onSaved={(n) => setA({ ...a, ...n })} />
          <Requests article={a} />

          <h2>Historique</h2>
          <ol className="timeline">
            {a.mouvements.map((mv) => (
              <li key={mv.id}>
                <strong>{MOVE_TYPE[mv.type] ?? mv.type}</strong>
                <span>{new Date(mv.le).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })}</span>
                {mv.motif && <small>{mv.motif}</small>}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}

interface Notes {
  nom_client: string | null;
  reference_interne: string | null;
  categorie_client: string | null;
  note_client: string | null;
}

/** INV-06 : le client nomme, référence, catégorise et annote ses biens à sa façon. */
function Annotation({ a, onSaved }: { a: ArticleDetail; onSaved: (n: Notes) => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ nomClient: '', referenceInterne: '', categorieClient: '', noteClient: '' });
  const [cats, setCats] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const readOnly = !!getSession()?.support;

  const start = () => {
    setF({ nomClient: a.nom_client ?? '', referenceInterne: a.reference_interne ?? '', categorieClient: a.categorie_client ?? '', noteClient: a.note_client ?? '' });
    setError(null);
    setOpen(true);
    void get<{ items: { nom: string }[] }>('/me/inventory/categories').then((r) => setCats(r.items.map((c) => c.nom)), () => undefined);
  };
  const save = async () => {
    setBusy(true);
    try {
      const r = await put<{ nomClient: string | null; referenceInterne: string | null; categorieClient: string | null; noteClient: string | null }>(`/articles/${a.id}/annotation`, f);
      onSaved({ nom_client: r.nomClient, reference_interne: r.referenceInterne, categorie_client: r.categorieClient, note_client: r.noteClient });
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  if (!open) {
    return (
      <section className="notes-box">
        <div className="notes-head">
          <h2>Mes annotations</h2>
          {!readOnly && (
            <button type="button" className="btn small" onClick={start}>
              {a.nom_client || a.reference_interne || a.categorie_client || a.note_client ? 'Modifier' : 'Annoter ce bien'}
            </button>
          )}
        </div>
        {a.note_client ? <p className="note-text">{a.note_client}</p> : <p className="hint small">Donnez à ce bien votre propre nom, votre référence d’immobilisation, une catégorie et une note : elles servent à la recherche et aux exports.</p>}
      </section>
    );
  }
  return (
    <form
      className="notes-box form-card"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2>Mes annotations</h2>
      <label>
        Mon nom pour ce bien
        <input value={f.nomClient} onChange={set('nomClient')} maxLength={120} placeholder={a.libelle} />
      </label>
      <div className="two">
        <label>
          Référence interne
          <input value={f.referenceInterne} onChange={set('referenceInterne')} maxLength={60} placeholder="Ex. IMMO-0042" />
        </label>
        <label>
          Ma catégorie
          <input value={f.categorieClient} onChange={set('categorieClient')} maxLength={60} list="client-cats" placeholder={a.categorie ?? ''} />
          <datalist id="client-cats">
            {cats.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
      </div>
      <label>
        Note
        <textarea value={f.noteClient} onChange={set('noteClient')} maxLength={1000} rows={3} />
      </label>
      {error && <Banner kind="error">{error}</Banner>}
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
          Annuler
        </button>
      </div>
    </form>
  );
}

const REQ_STATUS: Record<string, string> = { A_AFFECTER: 'Transmise au dépôt', AFFECTEE: 'Planifiée', EN_COURS: 'En cours', TERMINEE: 'Traitée' };

/** INV-07 : photo supplémentaire ou constat d'état, réalisé par un opérateur au dépôt. */
function Requests({ article }: { article: ArticleDetail }) {
  const [items, setItems] = useState<ArticleRequest[] | null>(null);
  const [type, setType] = useState<'PHOTO' | 'CONSTAT'>('PHOTO');
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readOnly = !!getSession()?.support;

  const load = () => get<{ items: ArticleRequest[] }>(`/articles/${article.id}/requests`).then((r) => setItems(r.items), () => setItems([]));
  useEffect(() => {
    void load();
  }, [article.id]);

  const pending = items?.find((r) => r.statut !== 'TERMINEE');
  const atDepot = article.statut === 'EN_STOCK' || article.statut === 'RESERVE';

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ prevueLe: string }>(`/articles/${article.id}/requests`, { type, message });
      setNotice(`Demande transmise au dépôt : elle sera traitée à partir du ${dateFr(r.prevueLe)}. Vous recevrez un e-mail quand la photo sera en ligne.`);
      setOpen(false);
      setMessage('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="requests-box">
      <div className="notes-head">
        <h2>Photo ou constat à la demande</h2>
        {!readOnly && !open && !pending && atDepot && (
          <button type="button" className="btn small" onClick={() => setOpen(true)}>
            Faire une demande
          </button>
        )}
      </div>
      {notice && <Banner kind="ok">{notice}</Banner>}
      {!open && !pending && !items?.length && (
        <p className="hint small">{atDepot ? 'Besoin d’une autre vue ou de vérifier l’état du bien ? Un opérateur le photographie au dépôt.' : 'Disponible quand le bien est au dépôt.'}</p>
      )}
      {open && (
        <form
          className="request-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="choice-row" role="radiogroup" aria-label="Type de demande">
            <label className="check">
              <input type="radio" name="req" checked={type === 'PHOTO'} onChange={() => setType('PHOTO')} /> Photo supplémentaire
            </label>
            <label className="check">
              <input type="radio" name="req" checked={type === 'CONSTAT'} onChange={() => setType('CONSTAT')} /> Constat d’état
            </label>
          </div>
          <label>
            Ce que vous voulez voir
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              maxLength={500}
              required
              minLength={3}
              placeholder={type === 'PHOTO' ? 'Ex. vue de dos, plaque signalétique, intérieur du tiroir' : 'Ex. le plateau est-il rayé ? les pieds sont-ils complets ?'}
            />
          </label>
          {error && <Banner kind="error">{error}</Banner>}
          <div className="row-actions">
            <button type="submit" className="btn primary" disabled={busy || message.trim().length < 3}>
              {busy ? 'Envoi…' : 'Envoyer la demande'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
              Annuler
            </button>
          </div>
          <p className="hint small">Traitée le jour ouvré suivant. Prestation facturée selon votre grille tarifaire.</p>
        </form>
      )}
      {!!items?.length && (
        <ul className="request-list">
          {items.map((r) => (
            <li key={r.id}>
              <span>
                <strong>{r.demande === 'CONSTAT' ? 'Constat d’état' : 'Photo supplémentaire'}</strong> · demandée le {dateFr(r.demandeeLe)}
              </span>
              <StatusPill label={REQ_STATUS[r.statut] ?? r.statut} tone={r.statut === 'TERMINEE' ? 'accent' : 'neutral'} />
              <small>« {r.message} »</small>
              {r.commentaire && <small>Réponse du dépôt : {r.commentaire}</small>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
