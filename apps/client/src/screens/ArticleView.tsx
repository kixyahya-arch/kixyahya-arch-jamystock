import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import { addToCart, useCarts } from '../lib/cart';
import { href } from '../lib/router';
import { ARTICLE_STATUS, CONDITION, MOVE_TYPE, dateFr, type ArticleDetail } from '../lib/types';
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
          <span className="eyebrow">— {a.categorie ?? 'Bien'}{a.projet ? ` · ${a.projet}` : ''}</span>
          <h1>{a.nom_client || a.libelle}</h1>
          {a.nom_client && <p className="hint">Désignation au dépôt : {a.libelle}</p>}
          <div className="status-row">
            <StatusPill label={ARTICLE_STATUS[a.statut] ?? a.statut} tone={engaged ? 'dark' : 'lime'} />
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
            <dt>Empilable</dt>
            <dd>{a.empilable ? 'Oui' : 'Non'}</dd>
            <dt>Entré au dépôt</dt>
            <dd>{dateFr(a.date_entree)}</dd>
            <dt>Emplacement</dt>
            <dd>{a.localisation ?? '—'}</dd>
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
