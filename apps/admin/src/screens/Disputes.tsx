import { useEffect, useState } from 'react';
import { get, post } from '../lib/api';
import { dateFr, timeFr } from '../lib/labels';
import { href } from '../lib/router';
import { Banner, Pills, StatusPill, Tile } from '../components/ui';

/** SUI-04 : réserves et litiges signalés par les clients après une livraison, liés au BL. */

type Statut = 'OUVERT' | 'EN_COURS' | 'RESOLU' | 'REJETE';
type Filter = 'A_TRAITER' | Statut | '';
interface Row {
  id: string;
  numero: string;
  motif: string;
  statut: Statut;
  creeLe: string;
  traiteLe: string | null;
  client: string;
  commande: string | null;
  bl: string;
  nbPhotos: number;
  extrait: string;
}
interface Photo {
  id: string;
  vignette: string;
  originale: string;
}
interface Detail {
  id: string;
  numero: string;
  commandeId: string;
  commande: string | null;
  bl: string | null;
  client: string | null;
  projet: string | null;
  auteur: string | null;
  motif: string;
  description: string;
  articles: { id: string; libelle: string; qrCode: string }[];
  photos: Photo[];
  statut: Statut;
  reponse: string | null;
  gesteCents: number | null;
  creeLe: string;
  traiteLe: string | null;
  traitePar: string | null;
  livraison: { id: string; numero: string; statut: string; signe_le: string; signataire_nom: string | null; lieu_depot: string | null; reserves: number };
}

export const MOTIF: Record<string, string> = { CASSE: 'Bien cassé', RAYURE: 'Rayure ou salissure', MANQUANT: 'Bien manquant', ERREUR: 'Erreur de bien', AUTRE: 'Autre' };
const STATUT: Record<Statut, string> = { OUVERT: 'À traiter', EN_COURS: 'En cours', RESOLU: 'Résolu', REJETE: 'Rejeté' };
const tone = (s: Statut) => (s === 'OUVERT' ? 'lime' : s === 'EN_COURS' ? 'dark' : s === 'REJETE' ? 'alert' : 'neutral');
const euros = (c: number) => (c / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });

export function Disputes({ isAdmin }: { isAdmin: boolean }) {
  const [filter, setFilter] = useState<Filter>('A_TRAITER');
  const [data, setData] = useState<{ items: Row[]; compteurs: Partial<Record<Statut, number>> } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    get<{ items: Row[]; compteurs: Partial<Record<Statut, number>> }>(`/bo/disputes${filter ? `?statut=${filter}` : ''}`).then(
      (r) => (setData(r), setError(null)),
      (e) => setError((e as Error).message),
    );
  useEffect(() => void load(), [filter]);
  const c = data?.compteurs ?? {};

  return (
    <>
      <section className="page-head">
        <span className="eyebrow">— Après livraison</span>
        <h1>Litiges</h1>
        <p className="lead">Problèmes signalés par les clients dans les 48 heures suivant une livraison, avec leurs photos et le bon de livraison.</p>
      </section>
      <div className="tiles">
        <Tile n={c.OUVERT ?? 0} label="À traiter" accent={!!c.OUVERT} onClick={() => setFilter('OUVERT')} />
        <Tile n={c.EN_COURS ?? 0} label="En cours" onClick={() => setFilter('EN_COURS')} />
        <Tile n={c.RESOLU ?? 0} label="Résolus" onClick={() => setFilter('RESOLU')} />
        <Tile n={c.REJETE ?? 0} label="Rejetés" onClick={() => setFilter('REJETE')} />
      </div>
      <Pills<Filter>
        label="Filtre"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'A_TRAITER', label: 'À traiter et en cours' },
          { value: '', label: 'Tous' },
          { value: 'RESOLU', label: 'Résolus' },
          { value: 'REJETE', label: 'Rejetés' },
        ]}
      />
      {error && <Banner kind="error">{error}</Banner>}
      <div className="bo-grid-2">
        <div className="col-main">
          {!data ? (
            <p className="hint">Chargement…</p>
          ) : data.items.length === 0 ? (
            <p className="empty">Aucun litige ici.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Signalé</th>
                    <th>Client</th>
                    <th>Problème</th>
                    <th>Statut</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((d) => (
                    <tr key={d.id} className={`clickable${open === d.id ? ' selected' : ''}`} onClick={() => setOpen(d.id)}>
                      <td className="nowrap">
                        {dateFr(d.creeLe)}
                        <div className="muted">{timeFr(d.creeLe)}</div>
                      </td>
                      <td>
                        <strong>{d.client}</strong>
                        <div className="muted mono">
                          {d.commande} · {d.bl}
                        </div>
                      </td>
                      <td>
                        <strong>{MOTIF[d.motif] ?? d.motif}</strong>
                        <div className="muted">{d.extrait}</div>
                        {d.nbPhotos > 0 && <div className="muted small">{d.nbPhotos} photo{d.nbPhotos > 1 ? 's' : ''}</div>}
                      </td>
                      <td>
                        <StatusPill label={STATUT[d.statut]} tone={tone(d.statut)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="col-side">{open ? <DisputeView id={open} isAdmin={isAdmin} onChanged={() => void load()} /> : <p className="hint">Choisissez un litige pour le traiter.</p>}</div>
      </div>
    </>
  );
}

function DisputeView({ id, isAdmin, onChanged }: { id: string; isAdmin: boolean; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [reponse, setReponse] = useState('');
  const [geste, setGeste] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = () => get<Detail>(`/bo/disputes/${id}`).then(setD, (e) => setError((e as Error).message));
  useEffect(() => {
    setD(null);
    setNotice(null);
    setReponse('');
    setGeste('');
    void load();
  }, [id]);

  const act = async (statut: 'EN_COURS' | 'RESOLU' | 'REJETE') => {
    setBusy(true);
    setError(null);
    try {
      const cents = geste ? Math.round(Number(geste.replace(',', '.')) * 100) : 0;
      await post(`/bo/disputes/${id}/resolve`, { statut, reponse: reponse.trim(), ...(statut === 'RESOLU' && cents > 0 ? { gesteCents: cents } : {}) });
      setNotice(statut === 'EN_COURS' ? 'Le client est prévenu de la prise en charge.' : statut === 'RESOLU' ? 'Litige résolu, le client est prévenu.' : 'Litige rejeté, le client est prévenu.');
      setReponse('');
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!d) return error ? <Banner kind="error">{error}</Banner> : <p className="hint">Chargement…</p>;
  const closed = d.statut === 'RESOLU' || d.statut === 'REJETE';
  const l = d.livraison;
  return (
    <section className="panel dispute-panel">
      <div className="panel-head">
        <h2>
          {MOTIF[d.motif] ?? d.motif} <span className="mono muted">{d.numero}</span>
        </h2>
        <StatusPill label={STATUT[d.statut]} tone={tone(d.statut)} />
      </div>
      <p className="muted">
        {d.client}
        {d.projet ? ` · ${d.projet}` : ''} · signalé par {d.auteur ?? 'le client'} le {dateFr(d.creeLe)} à {timeFr(d.creeLe)}
      </p>
      <p className="dispute-text">{d.description}</p>
      {d.articles.length > 0 && (
        <ul className="plain-list">
          {d.articles.map((a) => (
            <li key={a.id}>
              <a href={href({ name: 'article', id: a.id })}>{a.libelle}</a> <span className="mono muted">{a.qrCode}</span>
            </li>
          ))}
        </ul>
      )}
      {d.photos.length > 0 && (
        <div className="photo-row">
          {d.photos.map((p) => (
            <a key={p.id} href={p.originale} target="_blank" rel="noreferrer">
              <img src={p.vignette} alt="Photo du client" />
            </a>
          ))}
        </div>
      )}
      <dl className="facts">
        <dt>Demande</dt>
        <dd>
          <a href={href({ name: 'demande', id: d.commandeId })} className="mono">
            {d.commande}
          </a>
        </dd>
        <dt>Bon de livraison</dt>
        <dd>
          <span className="mono">{l.numero}</span> ·{' '}
          {l.statut === 'NON_SIGNE_DEPOSE' ? `déposé sans signature${l.lieu_depot ? ` (${l.lieu_depot})` : ''}` : `signé par ${l.signataire_nom ?? '—'}`}, le {dateFr(l.signe_le)} à {timeFr(l.signe_le)}
        </dd>
        <dt>Réserves au BL</dt>
        <dd>{l.reserves ? `${l.reserves} réserve${l.reserves > 1 ? 's' : ''} à la livraison` : 'Aucune'}</dd>
      </dl>
      {d.reponse && (
        <div className="callout">
          <strong>Réponse envoyée{d.traitePar ? ` par ${d.traitePar}` : ''} :</strong> {d.reponse}
          {d.gesteCents ? ` · Geste commercial ${euros(d.gesteCents)} HT, déduit de la prochaine facture.` : ''}
        </div>
      )}
      {notice && <Banner kind="ok">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
      {!closed && (
        <div className="dispute-actions">
          <label>
            Réponse au client
            <textarea rows={4} value={reponse} onChange={(e) => setReponse(e.target.value)} placeholder="Ce que nous faisons : remplacement, réparation, geste commercial…" />
          </label>
          {isAdmin && (
            <label>
              Geste commercial (€ HT, facultatif)
              <input inputMode="decimal" value={geste} onChange={(e) => setGeste(e.target.value)} placeholder="0" />
            </label>
          )}
          <div className="row-actions">
            {d.statut === 'OUVERT' && (
              <button type="button" className="btn" disabled={busy || reponse.trim().length < 3} onClick={() => void act('EN_COURS')}>
                Prendre en charge
              </button>
            )}
            <button type="button" className="btn primary" disabled={busy || reponse.trim().length < 3} onClick={() => void act('RESOLU')}>
              Résoudre
            </button>
            <button type="button" className="btn danger" disabled={busy || reponse.trim().length < 3 || !!geste} onClick={() => void act('REJETE')}>
              Rejeter
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
