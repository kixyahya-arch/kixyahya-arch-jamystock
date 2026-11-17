import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import type { BoContext, StockItem } from '../lib/types';
import { go } from '../lib/router';
import { DepotTabs } from './Warehouse';
import { ARTICLE_STATUS, CONDITION, dateFr } from '../lib/labels';
import { Banner, StatusPill, Thumb } from '../components/ui';

interface Page {
  total: number;
  items: StockItem[];
  suivant: string | null;
}

/** Stock de tout le dépôt, tous clients confondus, avec la même recherche que l'Espace Client (INV-03). */
export function Stock({ ctx, canCorrect = false }: { ctx: BoContext; canCorrect?: boolean }) {
  const [client, setClient] = useState('');
  const [statut, setStatut] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const params = (apres?: string) => {
    const p = new URLSearchParams({ limite: '48' });
    if (client) p.set('client', client);
    if (statut) p.set('statut', statut);
    if (q.trim()) p.set('q', q.trim());
    if (apres) p.set('apres', apres);
    return p;
  };

  useEffect(() => {
    const t = setTimeout(() => {
      get<Page>(`/articles?${params()}`)
        .then((r) => {
          setPage(r);
          setError(null);
        })
        .catch((e) => setError((e as Error).message));
    }, 200);
    return () => clearTimeout(t);
  }, [client, statut, q]);

  return (
    <>
      <section className="bo-head">
        <div>
          <p className="eyebrow">— Dépôt</p>
          <h1>Stock</h1>
          {canCorrect && <p className="lead">Cliquez sur un bien pour le déplacer, le déclarer perdu ou endommagé, ou réimprimer son étiquette.</p>}
        </div>
      </section>
      {canCorrect && <DepotTabs active="stock" />}
      <section className="toolbar">
        <input className="search" type="search" placeholder="Rechercher un bien : « bureau », « chaise »…" aria-label="Rechercher un bien" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Client" value={client} onChange={(e) => setClient(e.target.value)}>
          <option value="">Tous les clients</option>
          {ctx.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nom}
            </option>
          ))}
        </select>
        <select aria-label="Statut" value={statut} onChange={(e) => setStatut(e.target.value)}>
          <option value="">Présents au dépôt</option>
          {['EN_STOCK', 'RESERVE', 'EN_PREPARATION', 'EN_TRANSIT', 'RESTITUE', 'PERDU'].map((s) => (
            <option key={s} value={s}>
              {ARTICLE_STATUS[s]}
            </option>
          ))}
        </select>
        <span className="spacer" />
        {page && (
          <span className="muted">
            {page.total} bien{page.total > 1 ? 's' : ''}
          </span>
        )}
      </section>
      {error && <Banner kind="error">{error}</Banner>}
      {!page ? (
        !error && <p className="hint">Chargement…</p>
      ) : page.items.length === 0 ? (
        <p className="empty">Aucun bien ne correspond.</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th aria-label="Photo" />
                  <th>Bien</th>
                  <th>Client</th>
                  <th>Emplacement</th>
                  <th>État</th>
                  <th>Entré le</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((a) => (
                  <tr key={a.id} className={canCorrect ? 'clickable' : undefined} onClick={canCorrect ? () => go({ name: 'article', id: a.id }) : undefined}>
                    <td className="thumb-cell">
                      <Thumb src={a.vignette} alt="" />
                    </td>
                    <td>
                      <strong>{a.libelle}</strong>
                      {a.nomClient && a.nomClient !== a.libelle && <div className="muted">« {a.nomClient} »</div>}
                      <div className="muted mono">{a.qrCode}</div>
                    </td>
                    <td>{a.client}</td>
                    <td className="loc">{a.localisation ?? '—'}</td>
                    <td>{CONDITION[a.etat] ?? a.etat}</td>
                    <td>{dateFr(a.dateEntree)}</td>
                    <td>
                      <StatusPill label={ARTICLE_STATUS[a.statut] ?? a.statut} tone={a.statut === 'EN_STOCK' ? 'neutral' : a.statut === 'PERDU' ? 'alert' : 'dark'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page.suivant && (
            <div className="center">
              <button
                type="button"
                className="btn"
                disabled={loadingMore}
                onClick={async () => {
                  setLoadingMore(true);
                  try {
                    const r = await get<Page>(`/articles?${params(page.suivant!)}`);
                    setPage({ total: page.total, items: [...page.items, ...r.items], suivant: r.suivant });
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setLoadingMore(false);
                  }
                }}
              >
                Voir plus
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
