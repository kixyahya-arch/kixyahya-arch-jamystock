import { useCallback, useEffect, useState } from 'react';
import { del, get, post } from '../lib/api';
import { href } from '../lib/router';
import { ARTICLE_STATUS, CONDITION, MOVE_TYPE, dateFr, timeFr } from '../lib/labels';
import { Banner, Pills, StatusPill } from '../components/ui';
import { LabelsPanel } from './Warehouse';

const PHOTO_CONTEXT: Record<string, string> = {
  RECEPTION: 'Réception',
  LIVRAISON: 'Livraison',
  RESERVE: 'Réserve',
  A_LA_DEMANDE: 'À la demande du client',
  ENLEVEMENT: 'Enlèvement',
  ANOMALIE: 'Anomalie',
  DEPOT: 'Dépôt sans signature',
};

/** WMS-06 : consulter et corriger le stock. Chaque correction crée un mouvement « Ajustement » motivé, visible dans l'audit. */

interface Fiche {
  id: string;
  qrCode: string;
  libelle: string;
  statut: string;
  etat: string;
  dateEntree: string | null;
  couleur: string | null;
  emplacementOrigine: string | null;
  ancienCode: string | null;
  description: string | null;
  client: string;
  projet: string | null;
  categorie: string | null;
  emplacementId: string | null;
  emplacementCode: string | null;
  emplacement: string | null;
  umId: string | null;
  umQr: string | null;
  umType: string | null;
  umArticles: number;
  photos: { id: string; contexte: string; priseLe: string; supprimable: boolean; vignette: string; moyenne: string; originale: string }[];
  mouvements: { id: string; type: string; le: string; de: string | null; vers: string | null; statutAvant: string | null; statutApres: string | null; motif: string | null; auteur: string | null }[];
}

type Action = 'DEPLACER' | 'PERDU' | 'ENDOMMAGE' | 'RETROUVE' | 'DETRUIT' | 'RETIRER_UM' | 'FUSIONNER_UM';

const ACTIONS: { value: Action; label: string; when: (f: Fiche) => boolean; hint: string }[] = [
  { value: 'DEPLACER', label: 'Déplacer', when: (f) => ['EN_STOCK', 'RESERVE', 'EN_RECEPTION'].includes(f.statut), hint: 'Range l’article ailleurs. S’il était sur une palette, il la quitte (la palette reste en place).' },
  { value: 'RETIRER_UM', label: 'Sortir de la palette', when: (f) => !!f.umId, hint: 'Scinde l’unité : l’article reste à son emplacement (ou va à celui indiqué), sans palette.' },
  { value: 'FUSIONNER_UM', label: 'Fusionner les palettes', when: (f) => !!f.umId, hint: 'Tous les articles de cette palette passent sur la palette scannée, à son emplacement. L’ancienne palette est désactivée.' },
  { value: 'ENDOMMAGE', label: 'Endommagé', when: (f) => f.etat !== 'ENDOMMAGE' && !['RESTITUE', 'DETRUIT'].includes(f.statut), hint: 'Passe l’état à « Endommagé » ; le client le voit sur la fiche de l’article.' },
  { value: 'PERDU', label: 'Perdu', when: (f) => ['EN_STOCK', 'RESERVE', 'EN_RECEPTION', 'EN_PREPARATION'].includes(f.statut), hint: 'Sort l’article du stock et de la surface facturée. Il pourra être déclaré retrouvé.' },
  { value: 'RETROUVE', label: 'Retrouvé', when: (f) => f.statut === 'PERDU', hint: 'Remet l’article en stock à l’emplacement où il a été retrouvé.' },
  { value: 'DETRUIT', label: 'Détruit', when: (f) => ['EN_STOCK', 'PERDU', 'EN_RECEPTION'].includes(f.statut), hint: 'Sortie définitive (destruction à la demande du client, sinistre). Le QR est archivé.' },
];

export function StockArticle({ id }: { id: string }) {
  const [f, setF] = useState<Fiche | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [action, setAction] = useState<Action | ''>('');
  const [emplacement, setEmplacement] = useState('');
  const [um, setUm] = useState('');
  const [motif, setMotif] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      get<Fiche>(`/bo/warehouse/articles/${id}`)
        .then((x) => {
          setF(x);
          setAction((a) => (a && ACTIONS.find((o) => o.value === a)!.when(x) ? a : (ACTIONS.find((o) => o.when(x))?.value ?? '')));
        })
        .catch((e) => setError((e as Error).message)),
    [id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (!f) return error ? <Banner kind="error">{error}</Banner> : <p className="hint">Chargement…</p>;
  const available = ACTIONS.filter((a) => a.when(f));
  const current = ACTIONS.find((a) => a.value === action);
  const needsLoc = action === 'DEPLACER' || action === 'RETROUVE';

  return (
    <>
      <a className="back" href={href({ name: 'stock' })}>
        ← Stock
      </a>
      <section className="bo-head">
        <div>
          <p className="eyebrow">
            — Article · <span className="mono">{f.qrCode}</span>
          </p>
          <h1>{f.libelle}</h1>
          <p className="lead">
            {f.client}
            {f.projet ? ` · ${f.projet}` : ''}
            {f.categorie ? ` · ${f.categorie}` : ''}
          </p>
        </div>
        <StatusPill label={ARTICLE_STATUS[f.statut] ?? f.statut} tone={f.statut === 'PERDU' ? 'alert' : f.statut === 'EN_STOCK' ? 'dark' : 'neutral'} />
      </section>
      {notice && <Banner kind="ok">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
      <div className="two-col">
        <div className="col-main">
          <section className="panel">
            <h2>Position</h2>
            <dl className="facts">
              <dt>Emplacement</dt>
              <dd>{f.emplacement ? <>{f.emplacement} <span className="mono muted">{f.emplacementCode}</span></> : '—'}</dd>
              <dt>Palette</dt>
              <dd>{f.umQr ? <><span className="mono">{f.umQr}</span> · {f.umArticles} article{f.umArticles > 1 ? 's' : ''}</> : 'Aucune'}</dd>
              <dt>État</dt>
              <dd>{CONDITION[f.etat] ?? f.etat}</dd>
              <dt>Entré le</dt>
              <dd>{dateFr(f.dateEntree)}</dd>
              {f.couleur && (
                <>
                  <dt>Couleur</dt>
                  <dd>{f.couleur}</dd>
                </>
              )}
              {(f.emplacementOrigine || f.ancienCode) && (
                <>
                  <dt>Ancien logiciel</dt>
                  <dd>
                    {f.emplacementOrigine && <>Allée {f.emplacementOrigine}</>}
                    {f.emplacementOrigine && f.ancienCode && ' · '}
                    {f.ancienCode && <span className="mono">{f.ancienCode}</span>}
                  </dd>
                </>
              )}
            </dl>
            {f.description && <p className="muted small">{f.description}</p>}
          </section>
          <section className="panel">
            <h2>Photos ({f.photos.length})</h2>
            {f.photos.length === 0 ? (
              <p className="hint">Aucune photo : la prochaine prise à l’app terrain apparaîtra ici et dans l’Espace Client.</p>
            ) : (
              <ul className="photo-manage">
                {f.photos.map((p) => (
                  <li key={p.id}>
                    <a href={p.originale} target="_blank" rel="noreferrer" title="Ouvrir en haute définition">
                      <img src={p.vignette} alt={`Photo du ${dateFr(p.priseLe)}`} loading="lazy" />
                    </a>
                    <span className="muted small">
                      {PHOTO_CONTEXT[p.contexte] ?? p.contexte} · {dateFr(p.priseLe)}
                    </span>
                    {p.supprimable ? (
                      <button
                        type="button"
                        className="link danger"
                        disabled={busy}
                        onClick={async () => {
                          if (!window.confirm('Supprimer cette photo ? Elle disparaît aussi de l’Espace Client. Cette action est définitive.')) return;
                          setBusy(true);
                          try {
                            await del(`/bo/warehouse/articles/${f.id}/photos/${p.id}`);
                            setNotice('Photo supprimée, et tracée dans le journal d’audit.');
                            setError(null);
                            void load();
                          } catch (err) {
                            setError((err as Error).message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Supprimer
                      </button>
                    ) : (
                      <span className="muted small" title="Rattachée à un bon de livraison ou à une réserve">
                        Preuve, conservée
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="panel">
            <h2>Historique des mouvements</h2>
            <ol className="timeline">
              {f.mouvements.map((m) => (
                <li key={m.id} className={m.type === 'AJUSTEMENT' ? 'adjust' : ''}>
                  <div>
                    <strong>{MOVE_TYPE[m.type] ?? m.type}</strong>
                    {m.statutApres && m.statutAvant !== m.statutApres && <> · {ARTICLE_STATUS[m.statutApres] ?? m.statutApres}</>}
                  </div>
                  <span className="muted">
                    {dateFr(m.le)} à {timeFr(m.le)}
                    {m.auteur ? ` · ${m.auteur}` : ''}
                  </span>
                  {(m.de || m.vers) && m.de !== m.vers && (
                    <span className="muted small">
                      {m.de ?? '—'} → {m.vers ?? '—'}
                    </span>
                  )}
                  {m.motif && <span className="small">« {m.motif} »</span>}
                </li>
              ))}
            </ol>
          </section>
        </div>
        <aside className="col-side">
          <section className="panel">
            <h2>Corriger</h2>
            {available.length === 0 ? (
              <p className="hint">Aucune correction possible pour un article {ARTICLE_STATUS[f.statut]?.toLowerCase()}.</p>
            ) : (
              <form
                className="stack"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!action) return;
                  setBusy(true);
                  try {
                    await post(`/bo/warehouse/articles/${f.id}/correction`, {
                      action,
                      motif,
                      ...(emplacement ? { emplacement } : {}),
                      ...(action === 'FUSIONNER_UM' ? { umCible: um } : {}),
                    });
                    setNotice(`${current?.label} : correction enregistrée et tracée dans l’historique.`);
                    setError(null);
                    setMotif('');
                    setEmplacement('');
                    setUm('');
                    void load();
                  } catch (err) {
                    setError((err as Error).message);
                    setNotice(null);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Pills<Action | ''> label="Correction" value={action} onChange={setAction} options={available.map((a) => ({ value: a.value, label: a.label }))} />
                {current && <p className="hint">{current.hint}</p>}
                {(needsLoc || action === 'RETIRER_UM') && (
                  <label>
                    {action === 'RETIRER_UM' ? 'Nouvel emplacement (facultatif)' : 'Emplacement de destination'}
                    <input value={emplacement} onChange={(e) => setEmplacement(e.target.value)} required={needsLoc} placeholder="Code (N-B-04-101) ou QR scanné" className="mono" />
                  </label>
                )}
                {action === 'FUSIONNER_UM' && (
                  <label>
                    Palette qui reçoit les articles
                    <input value={um} onChange={(e) => setUm(e.target.value)} required placeholder="QR de la palette (U…)" className="mono" />
                  </label>
                )}
                <label>
                  Motif (obligatoire, visible dans l’audit)
                  <textarea value={motif} onChange={(e) => setMotif(e.target.value)} required minLength={3} rows={2} />
                </label>
                <button type="submit" className="btn primary" disabled={busy || !action}>
                  {busy ? '…' : `Enregistrer : ${current?.label.toLowerCase() ?? ''}`}
                </button>
              </form>
            )}
          </section>
          <section className="panel">
            <LabelsPanel ids={[f.id]} kind="ARTICLE" onError={setError} />
          </section>
        </aside>
      </div>
    </>
  );
}
