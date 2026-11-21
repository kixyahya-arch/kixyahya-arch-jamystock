import { useCallback, useEffect, useMemo, useState } from 'react';
import { PIECES } from '../lib/pieces';
import { apiBlob, del, get, post, put, saveBlob } from '../lib/api';
import { refreshCart } from '../lib/cart';
import { go, href } from '../lib/router';
import type { CartTemplate, Ctx, PackDetail } from '../lib/types';
import { Banner, Thumb } from '../components/ui';

const A_REPARTIR = 'À répartir';
const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? 's' : ''}`;

async function downloadPlanche(p: { id: string; nom: string }) {
  const blob = await apiBlob(`/me/cart-templates/${p.id}/planche.pdf`);
  saveBlob(
    blob,
    `planche-${p.nom
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .toLowerCase()}.pdf`,
  );
}

/** Packs du client : ensembles de meubles pour un logement ou un site, à commander en un clic. */
export function Packs({ ctx, role }: { ctx: Ctx; role: string }) {
  const [items, setItems] = useState<CartTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [nom, setNom] = useState('');
  const [projetId, setProjetId] = useState(role === 'B2B_USER' ? (ctx.projets[0]?.id ?? '') : '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<{ items: CartTemplate[] }>('/me/cart-templates').then(
      (r) => setItems(r.items),
      (e) => setError((e as Error).message),
    );
  }, []);

  // un pack naît vide : on choisit ses biens juste après, sur sa page
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ id: string }>('/me/cart-templates', {
        nom: nom.trim(),
        ...(projetId ? { projetId } : {}),
        articleIds: [],
      });
      go({ name: 'pack', id: r.id });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <section className="page-head">
        <span className="eyebrow">— Packs</span>
        <h1>Mes packs</h1>
        <p className="lead">
          Un pack regroupe les meubles d’un logement ou d’un site, pièce par pièce. Vous le faites livrer en un clic et en tirez une planche d’aménagement à partager.
        </p>
      </section>
      {error && <Banner kind="error">{error}</Banner>}
      <div className="row-actions packs-actions">
        {creating ? (
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <label>
              Nom du pack
              <input value={nom} onChange={(e) => setNom(e.target.value)} maxLength={80} placeholder="Ex. Appartement témoin T3" autoFocus />
            </label>
            {ctx.projets.length > 0 && (
              <label>
                Site
                <select value={projetId} onChange={(e) => setProjetId(e.target.value)}>
                  {role !== 'B2B_USER' && <option value="">Tous mes biens</option>}
                  {ctx.projets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nom}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="submit" className="btn primary" disabled={busy || !nom.trim()}>
              {busy ? '…' : 'Créer et choisir les biens'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setCreating(false)}>
              Annuler
            </button>
          </form>
        ) : (
          <button type="button" className="btn primary" onClick={() => setCreating(true)}>
            Nouveau pack
          </button>
        )}
      </div>
      {!items && !error && <p className="hint">Chargement…</p>}
      {items && items.length === 0 && (
        <p className="empty">
          Aucun pack pour l’instant. Créez-en un ici, ou enregistrez votre <a href={href({ name: 'panier' })}>panier</a> comme pack.
        </p>
      )}
      <ul className="pack-grid">
        {items?.map((p) => (
          <li key={p.id}>
            <a href={href({ name: 'pack', id: p.id })} className="pack-card">
              <span className="pack-covers" data-n={Math.min(p.vignettes?.length ?? 0, 4)}>
                {(p.vignettes?.length ? p.vignettes : [null]).slice(0, 4).map((v, i) => (
                  <Thumb key={i} src={v} alt="" />
                ))}
              </span>
              <strong>{p.nom}</strong>
              <span className="hint small">
                {p.projet ?? 'Tous sites'} · {plural(p.nbArticles, 'bien')}
                {p.pieces ? ` · ${plural(p.pieces, 'pièce')}` : ''}
              </span>
              <span className={`small ${p.nbDisponibles === p.nbArticles ? 'ok-text' : 'hint'}`}>
                {p.nbDisponibles === p.nbArticles ? 'Tout est disponible' : `${p.nbDisponibles} sur ${p.nbArticles} disponible${p.nbDisponibles > 1 ? 's' : ''}`}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Un pack : ses biens rangés par pièce, à compléter, commander, ou imprimer en planche d'aménagement. */
export function PackView({ id }: { id: string }) {
  const [p, setP] = useState<PackDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    kind: 'ok' | 'info';
    text: string;
    details?: string[];
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setP(await get<PackDetail>(`/me/cart-templates/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (
    body: {
      nom?: string;
      description?: string | null;
      articleIds?: string[];
      pieces?: Record<string, string | null>;
    },
    label: string,
  ) => {
    setBusy(label);
    setError(null);
    try {
      setP(await put<PackDetail>(`/me/cart-templates/${id}`, body));
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!p) return error ? <Banner kind="error">{error}</Banner> : <p className="hint">Chargement…</p>;
  const ids = p.articles.map((a) => a.id);
  const empty = ids.length === 0;

  const order = async () => {
    setBusy('order');
    setNotice(null);
    try {
      const r = await post<{
        ajoutes: number;
        indisponibles: { libelle: string; raison: string }[];
        projetId: string | null;
      }>(`/me/cart-templates/${id}/use`);
      await refreshCart(r.projetId);
      setNotice({
        kind: r.indisponibles.length ? 'info' : 'ok',
        text: `${plural(r.ajoutes, 'bien')} ajouté${r.ajoutes > 1 ? 's' : ''} au panier.${r.indisponibles.length ? ` ${r.indisponibles.length} indisponible${r.indisponibles.length > 1 ? 's' : ''} :` : ''}`,
        details: r.indisponibles.map((x) => `${x.libelle} : ${x.raison}`),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <a className="back-link" href={href({ name: 'packs' })}>
        ← Mes packs
      </a>
      <section className="page-head">
        <span className="eyebrow">— Pack{p.projet ? ` · ${p.projet}` : ''}</span>
        {editing && p.modifiable ? (
          <EditHead p={p} busy={!!busy} onCancel={() => setEditing(false)} onSave={async (nom, description) => (await save({ nom, description }, 'head')) && setEditing(false)} />
        ) : (
          <>
            <h1>{p.nom}</h1>
            {p.description && <p className="lead">{p.description}</p>}
          </>
        )}
        <p className="hint">
          {plural(p.nbArticles, 'bien')} · {p.nbDisponibles === p.nbArticles ? 'tous disponibles' : `${p.nbDisponibles} disponible${p.nbDisponibles > 1 ? 's' : ''}`}
          {p.auteur ? ` · composé par ${p.auteur}` : ''}
        </p>
      </section>
      {error && <Banner kind="error">{error}</Banner>}
      {notice && (
        <Banner kind={notice.kind}>
          {notice.text} {notice.kind === 'ok' || notice.details?.length ? <a href={href({ name: 'panier' })}>Voir le panier</a> : null}
          {!!notice.details?.length && (
            <ul className="report-list">
              {notice.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}
      <div className="row-actions pack-toolbar">
        <button type="button" className="btn primary" disabled={!!busy || p.nbDisponibles === 0} onClick={() => void order()}>
          {busy === 'order' ? 'Ajout…' : 'Me faire livrer ce pack'}
        </button>
        <button
          type="button"
          className="btn secondary"
          disabled={!!busy || empty}
          onClick={() => {
            setBusy('pdf');
            downloadPlanche(p)
              .catch((e) => setError((e as Error).message))
              .finally(() => setBusy(null));
          }}
        >
          {busy === 'pdf' ? 'Préparation…' : 'Planche d’aménagement (PDF)'}
        </button>
        {p.modifiable && !editing && (
          <button type="button" className="btn secondary" onClick={() => setEditing(true)}>
            Renommer
          </button>
        )}
        {p.modifiable && (
          <button
            type="button"
            className="link danger-link"
            disabled={!!busy}
            onClick={async () => {
              if (!window.confirm(`Supprimer le pack « ${p.nom} » ? Les biens restent dans votre stock.`)) return;
              await del(`/me/cart-templates/${id}`);
              go({ name: 'packs' });
            }}
          >
            Supprimer le pack
          </button>
        )}
      </div>

      {empty && <p className="empty">Ce pack est vide : ajoutez des biens ci-dessous.</p>}
      {p.pieces.map((g) => (
        <section key={g.piece ?? '—'} className="pack-room">
          <h2>
            {g.piece ?? A_REPARTIR} <span className="hint">· {plural(g.articles.length, 'bien')}</span>
          </h2>
          {g.piece === null && p.modifiable && <p className="hint small">Indiquez la pièce de chaque bien : la planche d’aménagement les présentera pièce par pièce.</p>}
          <ul className="pack-items">
            {g.articles.map((a) => (
              <li key={a.id} className={a.indisponible ? 'off' : ''}>
                <a href={href({ name: 'article', id: a.id })} className="pack-photo">
                  <Thumb src={a.vignette} alt="" />
                </a>
                <div className="pack-item-body">
                  <a href={href({ name: 'article', id: a.id })}>
                    <strong>{a.libelle}</strong>
                  </a>
                  <span className="hint small">
                    {a.qr && <span className="mono">{a.qr}</span>}
                    {a.dimensions ? ` · ${a.dimensions}` : ''}
                  </span>
                  <span className={`small ${a.indisponible ? 'warn-text' : 'hint'}`}>{a.indisponible ? `Indisponible : ${a.indisponible}` : (a.statut ?? '')}</span>
                  {p.modifiable && (
                    <div className="pack-item-edit">
                      <PieceInput value={a.piece} disabled={!!busy} onChange={(v) => void save({ pieces: { [a.id]: v } }, a.id)} label={`Pièce de ${a.libelle}`} />
                      <button type="button" className="link" disabled={!!busy} onClick={() => void save({ articleIds: ids.filter((x) => x !== a.id) }, a.id)}>
                        Retirer
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {p.modifiable && (
        <AddArticles
          projetId={p.projetId}
          already={new Set(ids)}
          busy={!!busy}
          onAdd={(articleId, piece) =>
            save(
              {
                articleIds: [...ids, articleId],
                pieces: { [articleId]: piece },
              },
              'add',
            )
          }
        />
      )}
      <datalist id="pieces-courantes">
        {PIECES.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
      <p className="hint small pack-ai">Bientôt : un visuel de chaque pièce aménagée avec vos meubles, ajouté en tête de pièce sur la planche.</p>
    </>
  );
}

function EditHead({ p, busy, onSave, onCancel }: { p: PackDetail; busy: boolean; onSave: (nom: string, description: string | null) => void; onCancel: () => void }) {
  const [nom, setNom] = useState(p.nom);
  const [description, setDescription] = useState(p.description ?? '');
  return (
    <form
      className="stack pack-edit"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(nom.trim(), description.trim() || null);
      }}
    >
      <label>
        Nom du pack
        <input value={nom} onChange={(e) => setNom(e.target.value)} maxLength={80} required />
      </label>
      <label>
        Description (facultative)
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} placeholder="Ex. Appartement témoin, 3 pièces, style scandinave" />
      </label>
      <span className="row-actions">
        <button type="submit" className="btn primary small" disabled={busy || !nom.trim()}>
          Enregistrer
        </button>
        <button type="button" className="btn ghost small" onClick={onCancel}>
          Annuler
        </button>
      </span>
    </form>
  );
}

/** Pièce d'un bien : liste des pièces courantes, ou saisie libre (« Chambre 2 », « Mezzanine »). */
function PieceInput({ value, onChange, disabled, label }: { value: string | null; onChange: (v: string | null) => void; disabled: boolean; label: string }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => setV(value ?? ''), [value]);
  const commit = () => {
    const next = v.trim() || null;
    if (next !== (value ?? null)) onChange(next);
  };
  return (
    <input
      className="piece-input"
      list="pieces-courantes"
      value={v}
      disabled={disabled}
      aria-label={label}
      placeholder="Pièce…"
      maxLength={40}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

interface Found {
  id: string;
  libelle: string;
  nomClient: string | null;
  qrCode: string;
  statut: string;
  engage?: boolean;
  vignette: string | null;
}

const SEARCH_STATUS: Record<string, string> = { RESERVE: 'réservé', EN_PREPARATION: 'en préparation', EN_TRANSIT: 'en livraison', ATTENDU: 'attendu au dépôt', EN_RECEPTION: 'en réception' };

/** Ajouter des biens au pack : recherche dans le stock (du site du pack, s'il en a un). */
function AddArticles({
  projetId,
  already,
  busy,
  onAdd,
}: {
  projetId: string | null;
  already: Set<string>;
  busy: boolean;
  onAdd: (id: string, piece: string | null) => Promise<boolean>;
}) {
  const [q, setQ] = useState('');
  const [piece, setPiece] = useState('');
  const [found, setFound] = useState<Found[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      const params = new URLSearchParams({ limite: '24' });
      if (q.trim()) params.set('q', q.trim());
      if (projetId) params.set('projet', projetId);
      get<{ items: Found[] }>(`/articles?${params}`).then(
        (r) => setFound(r.items.filter((a) => !['RESTITUE', 'PERDU', 'DETRUIT'].includes(a.statut))),
        (e) => setError((e as Error).message),
      );
    }, 250);
    return () => clearTimeout(t);
  }, [q, projetId]);
  const shown = useMemo(() => found?.filter((a) => !already.has(a.id)) ?? [], [found, already]);

  return (
    <section className="pack-add">
      <h2>Ajouter des biens</h2>
      <div className="two">
        <label>
          Rechercher dans mon stock
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Canapé, table, étiquette…" />
        </label>
        <label>
          Pièce des biens ajoutés
          <input list="pieces-courantes" value={piece} onChange={(e) => setPiece(e.target.value)} placeholder="Ex. Salon" maxLength={40} />
        </label>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      {found && shown.length === 0 && <p className="hint">Aucun autre bien ne correspond.</p>}
      <ul className="pack-found">
        {shown.map((a) => (
          <li key={a.id}>
            <Thumb src={a.vignette} alt="" />
            <span>
              <strong>{a.nomClient || a.libelle}</strong>
              <span className="hint small">
                <span className="mono">{a.qrCode}</span>
                {a.statut !== 'EN_STOCK' ? ` · ${SEARCH_STATUS[a.statut] ?? a.statut.toLowerCase()}` : a.engage ? ' · déjà dans une commande' : ''}
              </span>
            </span>
            <button type="button" className="btn secondary small" disabled={busy} onClick={() => void onAdd(a.id, piece.trim() || null)}>
              Ajouter
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
