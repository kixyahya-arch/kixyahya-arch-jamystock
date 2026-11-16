import { useEffect, useMemo, useState } from 'react';
import { get } from '../lib/api';
import { addToCart, useCarts } from '../lib/cart';
import { href } from '../lib/router';
import { ARTICLE_STATUS, CONDITION, type Article, type Ctx, type Page, type Surface } from '../lib/types';
import { Banner, Pills, StatusPill, Thumb } from '../components/ui';
import { Gauge } from '../components/Gauge';

interface Filters {
  projet: string;
  q: string;
  categorie: string;
  depot: string;
  etat: string;
  statut: string;
  entreDu: string;
  entreAu: string;
}
const EMPTY: Filters = { projet: '', q: '', categorie: '', depot: '', etat: '', statut: '', entreDu: '', entreAu: '' };

/** INV-01 à INV-04 : grille de vignettes, filtres, recherche, regroupement par projet, jauge m². */
export function Inventory({ ctx, canOrder }: { ctx: Ctx; canOrder: boolean }) {
  const [f, setF] = useState<Filters>(EMPTY);
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page<Article> | null>(null);
  const [more, setMore] = useState(false);
  const [surface, setSurface] = useState<Surface | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { inCart } = useCarts();

  const query = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    p.set('limite', '48');
    return p;
  }, [f]);

  useEffect(() => {
    void get<Surface>('/me/surface').then(setSurface).catch(() => undefined);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setF((x) => (x.q === q ? x : { ...x, q })), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let live = true;
    setPage(null);
    get<Page<Article>>(`/articles?${query}`)
      .then((r) => live && (setPage(r), setError(null)))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [query]);

  const loadMore = async () => {
    if (!page?.suivant) return;
    setMore(true);
    const p = new URLSearchParams(query);
    p.set('apres', page.suivant);
    const r = await get<Page<Article>>(`/articles?${p}`);
    setPage({ total: page.total, items: [...page.items, ...r.items], suivant: r.suivant });
    setMore(false);
  };

  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const projectName = (id: string | null) => ctx.projets.find((p) => p.id === id)?.nom;
  const active = Object.entries(f).filter(([k, v]) => v && k !== 'projet').length;

  return (
    <>
      <section className="hero">
        <div>
          <span className="eyebrow">— {ctx.entreprise.nom}</span>
          <h1>Mon stock</h1>
          <p className="lead">Chaque bien est photographié à son arrivée et localisé au dépôt. Ajoutez au panier ce dont vous avez besoin : on vous le livre.</p>
        </div>
        {surface && <Gauge s={surface} />}
      </section>

      {ctx.projets.length > 0 && (
        <Pills label="Projets" value={f.projet} onChange={(projet) => setF({ ...f, projet })} options={[{ value: '', label: 'Tous les projets' }, ...ctx.projets.map((p) => ({ value: p.id, label: p.nom }))]} />
      )}

      <div className="toolbar">
        <input className="search" type="search" placeholder="Rechercher un bien : « bureau », « chaise »…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher" />
        <details className="filters">
          <summary className="btn secondary small">Filtres{active > 0 ? ` · ${active}` : ''}</summary>
          <div className="filters-grid">
            <label>
              Catégorie
              <select value={f.categorie} onChange={set('categorie')}>
                <option value="">Toutes</option>
                {ctx.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.nom}
                  </option>
                ))}
              </select>
            </label>
            {ctx.depots.length > 1 && (
              <label>
                Dépôt
                <select value={f.depot} onChange={set('depot')}>
                  <option value="">Tous</option>
                  {ctx.depots.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.nom}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              État
              <select value={f.etat} onChange={set('etat')}>
                <option value="">Tous</option>
                {Object.entries(CONDITION).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Statut
              <select value={f.statut} onChange={set('statut')}>
                <option value="">Présents au dépôt</option>
                {Object.entries(ARTICLE_STATUS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Entré depuis le
              <input type="date" value={f.entreDu} onChange={set('entreDu')} />
            </label>
            <label>
              Jusqu’au
              <input type="date" value={f.entreAu} onChange={set('entreAu')} />
            </label>
            <button type="button" className="link" onClick={() => (setF({ ...EMPTY, projet: f.projet }), setQ(''))}>
              Effacer les filtres
            </button>
          </div>
        </details>
        <span className="count-label">{page ? `${page.total} bien${page.total > 1 ? 's' : ''}` : ''}</span>
      </div>

      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="error">{notice}</Banner>}
      {!page && !error && <p className="hint">Chargement…</p>}
      {page && page.items.length === 0 && <p className="empty">Aucun bien ne correspond à ces critères.</p>}

      <ul className="grid">
        {page?.items.map((a) => {
          const taken = inCart.has(a.id);
          const available = a.statut === 'EN_STOCK' && !a.engage;
          return (
            <li key={a.id} className="card">
              <a href={href({ name: 'article', id: a.id })} className="card-link">
                <Thumb src={a.vignette} alt={a.libelle} />
                <span className="card-body">
                  <span className="card-title">{a.nomClient || a.libelle}</span>
                  <span className="card-meta">
                    {[a.categorie, projectName(a.projetId)].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </a>
              <div className="card-foot">
                <StatusPill label={a.engage && a.statut === 'EN_STOCK' ? 'Dans une commande' : (ARTICLE_STATUS[a.statut] ?? a.statut)} tone={a.statut === 'EN_STOCK' && !a.engage ? 'neutral' : 'dark'} />
                {canOrder && available && (
                  <button
                    type="button"
                    className={`btn small ${taken ? 'secondary' : 'primary'}`}
                    disabled={taken}
                    onClick={() => void addToCart(a.id, a.projetId).then(() => setNotice(null), (e) => setNotice((e as Error).message))}
                  >
                    {taken ? 'Dans le panier ✓' : 'Ajouter'}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {page?.suivant && (
        <div className="center">
          <button type="button" className="btn secondary" onClick={() => void loadMore()} disabled={more}>
            {more ? 'Chargement…' : 'Voir plus de biens'}
          </button>
        </div>
      )}

      <section className="band">
        <h2>De nouveaux biens à stocker ?</h2>
        <p>On vient les chercher, on les photographie et on les range. Ils apparaissent ici dès leur arrivée.</p>
        <a className="btn primary" href={href({ name: 'collecte' })}>
          Demander une collecte
        </a>
      </section>
    </>
  );
}
