import { useEffect, useMemo, useState } from 'react';
import { get, getSession, post } from '../lib/api';
import { go, href } from '../lib/router';
import type { Article, Ctx, Order, Page } from '../lib/types';
import { Banner, Pills, Thumb } from '../components/ui';

type Mode = 'RETOUR' | 'TRANSFERT';
const SANS_PROJET = '_';

/**
 * Objets installés chez le client (bureaux de vente, appartements témoins, sièges…), regroupés par site.
 * Le client peut les faire revenir au dépôt ou les faire déplacer vers un autre de ses sites.
 */
export function OnSite({ ctx, role }: { ctx: Ctx; role: string }) {
  const [items, setItems] = useState<Article[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [site, setSite] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<Mode | null>(null);
  const readOnly = !!getSession()?.support;

  useEffect(() => {
    let live = true;
    (async () => {
      const all: Article[] = [];
      let apres: string | null = null;
      // au plus 2 000 objets : au-delà, le filtre par site prend le relais
      for (let i = 0; i < 10; i++) {
        const p = new URLSearchParams({ statut: 'RESTITUE', limite: '200' });
        if (apres) p.set('apres', apres);
        const r: Page<Article> = await get<Page<Article>>(`/articles?${p}`);
        all.push(...r.items);
        apres = r.suivant;
        if (!apres) break;
      }
      if (live) setItems(all);
    })().catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, []);

  const groups = useMemo(() => {
    const m = new Map<string, Article[]>();
    for (const a of items ?? []) {
      const k = a.projetId ?? SANS_PROJET;
      m.set(k, [...(m.get(k) ?? []), a]);
    }
    const name = (k: string) => (k === SANS_PROJET ? 'Sans projet' : (ctx.projets.find((p) => p.id === k)?.nom ?? 'Autre site'));
    return [...m.entries()].map(([k, list]) => ({ key: k, nom: name(k), list })).sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  }, [items, ctx.projets]);

  const shown = site ? groups.filter((g) => g.key === site) : groups;
  const selectedSite = groups.find((g) => g.list.some((a) => selected.has(a.id)))?.key ?? null;
  const toggle = (a: Article) => {
    const k = a.projetId ?? SANS_PROJET;
    // une demande part d'un seul site à la fois : changer de site repart d'une sélection vide
    const base = selectedSite && selectedSite !== k ? new Set<string>() : new Set(selected);
    if (base.has(a.id)) base.delete(a.id);
    else if (!a.engage) base.add(a.id);
    setSelected(base);
  };
  const selectAll = (g: { key: string; list: Article[] }) => setSelected(new Set(g.list.filter((a) => !a.engage).map((a) => a.id)));

  return (
    <>
      <section className="page-head">
        <span className="eyebrow">— {ctx.entreprise.nom}</span>
        <h1>Sur mes sites</h1>
        <p className="lead">Les objets livrés et installés chez vous. Sélectionnez-en pour les faire revenir au dépôt ou les déplacer vers un autre site.</p>
      </section>

      {groups.length > 1 && groups.length <= 6 && (
        <Pills label="Sites" value={site} onChange={setSite} options={[{ value: '', label: 'Tous les sites' }, ...groups.map((g) => ({ value: g.key, label: `${g.nom} (${g.list.length})` }))]} />
      )}
      {groups.length > 6 && (
        <div className="toolbar">
          <label className="site-filter">
            Site
            <select value={site} onChange={(e) => setSite(e.target.value)}>
              <option value="">Tous les sites ({groups.length})</option>
              {groups.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.nom} ({g.list.length})
                </option>
              ))}
            </select>
          </label>
          <span className="count-label">{items?.length ?? 0} objets sur vos sites</span>
        </div>
      )}

      {error && <Banner kind="error">{error}</Banner>}
      {!items && !error && <p className="hint">Chargement…</p>}
      {items?.length === 0 && (
        <p className="empty">
          Aucun objet installé sur vos sites pour le moment. <a href={href({ name: 'inventaire' })}>Voir le stock au dépôt</a>
        </p>
      )}

      {shown.map((g) => (
        <section key={g.key} className="site-group">
          <div className="site-head">
            <h2>
              {g.nom} <span className="count-label">{g.list.length} objet{g.list.length > 1 ? 's' : ''}</span>
            </h2>
            {!readOnly && (
              <button type="button" className="link" onClick={() => selectAll(g)}>
                Tout sélectionner
              </button>
            )}
          </div>
          <ul className="grid">
            {g.list.map((a) => (
              <li key={a.id} className={`card${selected.has(a.id) ? ' selected' : ''}`}>
                <a href={href({ name: 'article', id: a.id })} className="card-link">
                  <Thumb src={a.vignette} alt={a.libelle} />
                  <span className="card-body">
                    <span className="card-title">{a.nomClient || a.libelle}</span>
                    <span className="card-meta">{[a.referenceInterne, a.categorieClient ?? a.categorie, a.couleur].filter(Boolean).join(' · ')}</span>
                  </span>
                </a>
                <div className="card-foot">
                  {a.engage ? (
                    <span className="status accent">Demande en cours</span>
                  ) : (
                    <button
                      type="button"
                      className={`btn small ${selected.has(a.id) ? 'primary' : 'secondary'}`}
                      aria-pressed={selected.has(a.id)}
                      disabled={readOnly}
                      onClick={() => toggle(a)}
                    >
                      {selected.has(a.id) ? 'Sélectionné ✓' : 'Sélectionner'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {selected.size > 0 && !mode && (
        <div className="select-bar" role="region" aria-label="Objets sélectionnés">
          <span>
            {selected.size} objet{selected.size > 1 ? 's' : ''} sélectionné{selected.size > 1 ? 's' : ''}
          </span>
          <button type="button" className="btn secondary small" onClick={() => setSelected(new Set())}>
            Annuler
          </button>
          <button type="button" className="btn small" onClick={() => setMode('TRANSFERT')}>
            Déplacer vers un autre site
          </button>
          <button type="button" className="btn primary small" onClick={() => setMode('RETOUR')}>
            Faire revenir au dépôt
          </button>
        </div>
      )}

      {mode && (
        <SiteRequest
          ctx={ctx}
          role={role}
          mode={mode}
          articleIds={[...selected]}
          fromProjet={selectedSite && selectedSite !== SANS_PROJET ? selectedSite : null}
          onCancel={() => setMode(null)}
        />
      )}
    </>
  );
}

function SiteRequest({
  ctx,
  role,
  mode,
  articleIds,
  fromProjet,
  onCancel,
}: {
  ctx: Ctx;
  role: string;
  mode: Mode;
  articleIds: string[];
  fromProjet: string | null;
  onCancel: () => void;
}) {
  const [adresse, setAdresse] = useState('');
  const [date, setDate] = useState('');
  const [contact, setContact] = useState({ nom: '', telephone: '' });
  const [destProjet, setDestProjet] = useState(ctx.projets.find((p) => p.id !== fromProjet)?.id ?? '');
  const [destAdresse, setDestAdresse] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = articleIds.length;
  const destNom = ctx.projets.find((p) => p.id === destProjet)?.nom;
  const ready =
    adresse.trim().length >= 3 &&
    date &&
    contact.nom.trim() &&
    contact.telephone.trim().length >= 6 &&
    (mode === 'RETOUR' || destAdresse.trim().length >= 3) &&
    (role !== 'B2B_USER' || fromProjet);
  const manque = [
    role === 'B2B_USER' && !fromProjet && 'le projet d’origine',
    adresse.trim().length < 3 && 'l’adresse où les reprendre',
    mode !== 'RETOUR' && destAdresse.trim().length < 3 && 'l’adresse de destination',
    !date && 'la date souhaitée',
    !contact.nom.trim() && 'le contact sur place',
    contact.telephone.trim().length < 6 && 'son téléphone',
  ].filter((x): x is string => !!x);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const what = `${n} objet${n > 1 ? 's' : ''}`;
    const description =
      (mode === 'RETOUR' ? `Retour au dépôt de ${what}` : `Transfert de ${what} vers ${destNom ?? destAdresse.trim()}`) + (note.trim() ? `\n${note.trim()}` : '');
    try {
      const o = await post<Order>('/collections', {
        ...(fromProjet ? { projetId: fromProjet } : {}),
        nature: mode,
        articleIds,
        adresse: { libelle: adresse.trim() },
        dateSouhaitee: date,
        description,
        contactSite: { nom: contact.nom.trim(), telephone: contact.telephone.trim() },
        ...(mode === 'TRANSFERT' ? { destination: { ...(destProjet ? { projetId: destProjet } : {}), adresse: { libelle: destAdresse.trim() } } } : {}),
      });
      go({ name: 'commande', id: o.id });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <section className="form-card narrow site-request">
      <h2>{mode === 'RETOUR' ? 'Faire revenir au dépôt' : 'Déplacer vers un autre site'}</h2>
      <p className="hint">
        {n} objet{n > 1 ? 's' : ''} sélectionné{n > 1 ? 's' : ''}.{' '}
        {mode === 'RETOUR'
          ? 'Nous les reprenons sur place avec leur étiquette, puis ils retrouvent leur place dans votre stock.'
          : 'Nous les reprenons sur place et les déposons directement sur le nouveau site, sans passer par le dépôt.'}
      </p>
      <label>
        Adresse où les reprendre
        <input value={adresse} onChange={(e) => setAdresse(e.target.value)} placeholder="N°, rue, code postal, ville" />
      </label>
      {mode === 'TRANSFERT' && (
        <>
          {ctx.projets.length > 0 && (
            <label>
              Projet de destination
              <select value={destProjet} onChange={(e) => setDestProjet(e.target.value)}>
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
            Adresse de destination
            <input value={destAdresse} onChange={(e) => setDestAdresse(e.target.value)} placeholder="N°, rue, code postal, ville" />
          </label>
        </>
      )}
      <label>
        Date souhaitée
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
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
      <label>
        Précisions (facultatif)
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Étage, accès, horaires…" />
      </label>
      {error && <Banner kind="error">{error}</Banner>}
      <div className="row-actions">
        <button type="button" className="btn secondary" onClick={onCancel} disabled={busy}>
          Retour
        </button>
        <button type="button" className="btn primary big" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? 'Envoi…' : 'Envoyer la demande'}
        </button>
      </div>
      {manque.length > 0 && <p className="hint small">À compléter : {manque.join(', ')}.</p>}
    </section>
  );
}
