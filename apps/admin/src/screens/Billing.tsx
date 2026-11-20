import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiBlob, get, openPdf, post, put } from '../lib/api';
import { go, href } from '../lib/router';
import type { BoContext } from '../lib/types';
import { AUDIT_ACTION, INVOICE_STATUS, LINE_TYPE, SNAPSHOT_SOURCE, dateFr, dateShort, euros, m2, monthFr, parseEuros, previousMonth } from '../lib/labels';
import { Banner, Pills, StatusPill, Tile } from '../components/ui';

/** Écrans de facturation du Super Admin (FAC-01 à FAC-04) : factures, avoirs, tarifs, surfaces quotidiennes. */

export interface InvoiceRow {
  id: string;
  numero: string | null;
  type: 'FACTURE' | 'AVOIR';
  statut: string;
  clientId: string;
  client: string;
  typeClient: 'B2B' | 'B2C';
  periodeDebut: string | null;
  periodeFin: string | null;
  m2Factures: number | null;
  totalHtCents: number;
  totalTtcCents: number;
  emiseLe: string | null;
  echeance: string | null;
  emissionPrevue: string | null;
  bloquee: boolean;
  motifBlocage: string | null;
  payeLe: string | null;
  origineNumero: string | null;
  enRetard: boolean;
  relanceNiveau?: number;
}

interface BillingSummary {
  brouillons: number;
  bloquees: number;
  aEncaisser: number;
  aEncaisserCents: number;
  enRetard: number;
  emisMoisHtCents: number;
  prochaineEmission: string | null;
  dernierInstantane: string | null;
  today: string;
}

export function invoiceTone(r: Pick<InvoiceRow, 'statut' | 'bloquee' | 'enRetard'>): 'neutral' | 'lime' | 'dark' | 'alert' {
  if (r.statut === 'BROUILLON') return r.bloquee ? 'alert' : 'lime';
  if (r.enRetard || r.statut === 'EN_RETARD') return 'alert';
  if (r.statut === 'EMISE') return 'dark';
  return 'neutral';
}
const statusLabel = (r: Pick<InvoiceRow, 'statut' | 'bloquee' | 'enRetard'>) =>
  r.statut === 'BROUILLON' && r.bloquee ? 'Brouillon bloqué' : r.enRetard ? 'En retard' : (INVOICE_STATUS[r.statut] ?? r.statut);
const period = (r: Pick<InvoiceRow, 'periodeDebut' | 'periodeFin'>) => {
  if (!r.periodeDebut) return '—';
  const [y, mo] = r.periodeDebut.split('-').map(Number) as [number, number];
  const lastDay = `${r.periodeDebut.slice(0, 7)}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`;
  const full = r.periodeDebut.endsWith('-01') && r.periodeFin === lastDay;
  return full ? monthFr(r.periodeDebut.slice(0, 7)) : `${dateShort(r.periodeDebut)} → ${dateShort(r.periodeFin)}`;
};

export function BillingTabs({ active }: { active: 'facturation' | 'tarifs' | 'surfaces' }) {
  return (
    <nav className="subnav" aria-label="Facturation">
      <a href={href({ name: 'facturation' })} aria-current={active === 'facturation' ? 'page' : undefined}>
        Factures et avoirs
      </a>
      <a href={href({ name: 'tarifs' })} aria-current={active === 'tarifs' ? 'page' : undefined}>
        Grilles et forfaits
      </a>
      <a href={href({ name: 'surfaces' })} aria-current={active === 'surfaces' ? 'page' : undefined}>
        Surfaces quotidiennes
      </a>
    </nav>
  );
}

type Filter = '' | 'BROUILLON' | 'IMPAYEE' | 'PAYEE' | 'AVOIR';

export function Invoices({ ctx }: { ctx: BoContext }) {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [rows, setRows] = useState<InvoiceRow[] | null>(null);
  const [filter, setFilter] = useState<Filter>('');
  const [client, setClient] = useState('');
  const [mois, setMois] = useState('');
  const [q, setQ] = useState('');
  const [genMois, setGenMois] = useState(previousMonth(ctx.today));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    get<BillingSummary>('/bo/billing/summary').then(setSummary).catch(() => undefined);
  }, [reload]);
  useEffect(() => {
    const p = new URLSearchParams();
    if (filter === 'AVOIR') p.set('type', 'AVOIR');
    else if (filter) p.set('statut', filter);
    if (client) p.set('client', client);
    if (mois) p.set('mois', mois);
    if (q.trim()) p.set('q', q.trim());
    const t = setTimeout(() => {
      get<{ items: InvoiceRow[] }>(`/bo/billing/invoices?${p}`)
        .then((r) => {
          setRows(r.items);
          setError(null);
        })
        .catch((e) => setError((e as Error).message));
    }, 150);
    return () => clearTimeout(t);
  }, [filter, client, mois, q, reload]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await fn());
      setError(null);
      setReload((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const generate = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await post<{ crees: number; recalcules: number; ignores: number }>('/bo/billing/drafts', { mois: genMois });
      const parts = [r.crees && `${r.crees} brouillon${r.crees > 1 ? 's' : ''} créé${r.crees > 1 ? 's' : ''}`, r.recalcules && `${r.recalcules} recalculé${r.recalcules > 1 ? 's' : ''}`, r.ignores && `${r.ignores} déjà émise${r.ignores > 1 ? 's' : ''}, inchangée${r.ignores > 1 ? 's' : ''}`].filter(Boolean);
      return `${monthFr(genMois)} : ${parts.length ? parts.join(', ') : 'aucun contrat à facturer'}.`;
    });
  };

  return (
    <>
      <section className="bo-head">
        <div>
          <p className="eyebrow">— Facturation</p>
          <h1>Factures et avoirs</h1>
          <p className="lead">Les brouillons du mois écoulé sont préparés le 1er à 2 h et partent seuls deux jours plus tard, sauf si vous les bloquez.</p>
        </div>
      </section>
      <BillingTabs active="facturation" />

      {summary && (
        <section className="tiles" aria-label="Chiffres de la facturation">
          <Tile n={summary.brouillons} label={`brouillon${summary.brouillons > 1 ? 's' : ''}${summary.prochaineEmission ? `, envoi le ${dateShort(summary.prochaineEmission)}` : ' à revoir'}`} accent={summary.brouillons > 0} onClick={() => setFilter('BROUILLON')} />
          <Tile n={summary.bloquees} label={summary.bloquees > 1 ? 'bloqués' : 'bloqué'} alert={summary.bloquees > 0} onClick={() => setFilter('BROUILLON')} />
          <Tile n={euros(summary.aEncaisserCents)} label={`à encaisser (${summary.aEncaisser} facture${summary.aEncaisser > 1 ? 's' : ''})`} onClick={() => setFilter('IMPAYEE')} />
          <Tile n={summary.enRetard} label="en retard de paiement" alert={summary.enRetard > 0} onClick={() => setFilter('IMPAYEE')} />
          <Tile n={euros(summary.emisMoisHtCents)} label="HT émis ce mois-ci" />
        </section>
      )}

      {notice && <Banner kind="ok">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}

      <section className="panel actions-panel">
        <form className="inline-form" onSubmit={generate}>
          <label className="inline">
            Préparer les brouillons de
            <input type="month" value={genMois} max={ctx.today.slice(0, 7)} onChange={(e) => setGenMois(e.target.value)} required />
          </label>
          <button className="btn primary" disabled={busy || !genMois}>
            Générer ou recalculer
          </button>
          <span className="spacer" />
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await post<{
                  instantanes: number;
                  brouillons: { mois: string; crees: number } | null;
                  emises: string[];
                  prelevements: { tentes: number; refuses: number } | null;
                  relances: { enRetard: number; relances: number } | null;
                }>('/bo/billing/run');
                const parts = [
                  r.instantanes ? `${r.instantanes} instantané(s) rattrapé(s)` : '',
                  r.brouillons ? `${r.brouillons.crees} brouillon(s) pour ${monthFr(r.brouillons.mois)}` : '',
                  r.emises.length ? `émises : ${r.emises.join(', ')}` : '',
                  r.prelevements?.tentes ? `${r.prelevements.tentes} prélèvement(s) lancé(s)${r.prelevements.refuses ? `, ${r.prelevements.refuses} refusé(s)` : ''}` : '',
                  r.relances?.enRetard ? `${r.relances.enRetard} facture(s) passée(s) en retard` : '',
                  r.relances?.relances ? `${r.relances.relances} relance(s) envoyée(s)` : '',
                ].filter(Boolean);
                return parts.length ? `Tâches lancées : ${parts.join(' ; ')}.` : 'Tâches lancées : tout était déjà à jour.';
              })
            }
          >
            Lancer les tâches automatiques maintenant
          </button>
        </form>
        {summary && (
          <p className="hint">
            Dernier relevé des surfaces : {summary.dernierInstantane ? dateFr(summary.dernierInstantane) : 'aucun'}. Recalculer un brouillon reprend les surfaces et les prestations à jour ; une facture émise n’est jamais modifiée.
          </p>
        )}
      </section>

      <section className="toolbar" aria-label="Filtres">
        <Pills<Filter>
          label="Statut"
          value={filter}
          onChange={setFilter}
          options={[
            { value: '', label: 'Tout' },
            { value: 'BROUILLON', label: 'Brouillons' },
            { value: 'IMPAYEE', label: 'À encaisser' },
            { value: 'PAYEE', label: 'Payées' },
            { value: 'AVOIR', label: 'Avoirs' },
          ]}
        />
        <input className="search" type="search" placeholder="N° ou client…" aria-label="Rechercher une facture" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Client" value={client} onChange={(e) => setClient(e.target.value)}>
          <option value="">Tous les clients</option>
          {ctx.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nom}
            </option>
          ))}
        </select>
        <label className="inline">
          Mois <input type="month" value={mois} onChange={(e) => setMois(e.target.value)} />
        </label>
      </section>

      {!rows ? (
        !error && <p className="hint">Chargement…</p>
      ) : rows.length === 0 ? (
        <p className="empty">Aucune facture ne correspond.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>N°</th>
                <th>Client</th>
                <th>Période</th>
                <th className="num">Surface</th>
                <th className="num">Total HT</th>
                <th className="num">Total TTC</th>
                <th>Date</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => go({ name: 'facture', id: r.id })}>
                  <td>
                    <a className="mono" href={href({ name: 'facture', id: r.id })} onClick={(e) => e.stopPropagation()}>
                      {r.numero ?? 'Brouillon'}
                    </a>
                    {r.type === 'AVOIR' && <div className="muted">Avoir sur {r.origineNumero}</div>}
                  </td>
                  <td>{r.client}</td>
                  <td className="cap">{period(r)}</td>
                  <td className="num">{r.m2Factures != null ? m2(r.m2Factures) : '—'}</td>
                  <td className="num">{euros(r.totalHtCents)}</td>
                  <td className="num">{euros(r.totalTtcCents)}</td>
                  <td>
                    {r.statut === 'BROUILLON'
                      ? r.bloquee
                        ? 'En attente de revue'
                        : `Envoi le ${dateShort(r.emissionPrevue)}`
                      : r.statut === 'PAYEE'
                        ? `Payée le ${dateShort(r.payeLe)}`
                        : r.type === 'FACTURE' && r.statut !== 'ANNULEE'
                          ? `Échéance ${dateShort(r.echeance)}`
                          : `Émis le ${dateShort(r.emiseLe)}`}
                    {r.relanceNiveau && ['EMISE', 'EN_RETARD'].includes(r.statut) ? <div className="muted">Relance {r.relanceNiveau}/3 envoyée</div> : null}
                  </td>
                  <td>
                    <StatusPill label={statusLabel(r)} tone={invoiceTone(r)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="bo-grid-2">
        <AccountingExport today={ctx.today} />
        <DunningSettingsPanel />
      </div>
    </>
  );
}

/** FAC-06 : fichier des écritures pour l'expert-comptable (FEC normalisé ou CSV pour tableur). */
function AccountingExport({ today }: { today: string }) {
  const [du, setDu] = useState(`${previousMonth(today)}-01`);
  const [au, setAu] = useState(() => {
    const d = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
    d.setUTCDate(0);
    return d.toISOString().slice(0, 10);
  });
  const [busy, setBusy] = useState<'' | 'fec' | 'csv'>('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const download = async (format: 'fec' | 'csv') => {
    setBusy(format);
    setMsg(null);
    try {
      const blob = await apiBlob(`/bo/billing/export?du=${du}&au=${au}&format=${format}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = format === 'fec' ? `FEC-${du}-${au}.txt` : `ecritures-${du}-${au}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setMsg({ kind: 'ok', text: 'Fichier téléchargé.' });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy('');
    }
  };
  return (
    <section className="panel">
      <h2>Export comptable</h2>
      <p className="hint">Factures et avoirs émis au journal des ventes (411, 706, 4457 par taux de TVA), règlements reçus au journal de banque (512). Chaque écriture est équilibrée.</p>
      <div className="inline-form">
        <label className="inline">
          Du <input type="date" value={du} max={au} onChange={(e) => setDu(e.target.value)} />
        </label>
        <label className="inline">
          au <input type="date" value={au} min={du} onChange={(e) => setAu(e.target.value)} />
        </label>
      </div>
      <div className="row-actions">
        <button type="button" className="btn primary" disabled={!!busy || !du || !au} onClick={() => void download('fec')}>
          {busy === 'fec' ? 'Préparation…' : 'Fichier FEC'}
        </button>
        <button type="button" className="btn" disabled={!!busy || !du || !au} onClick={() => void download('csv')}>
          {busy === 'csv' ? 'Préparation…' : 'CSV pour tableur'}
        </button>
      </div>
      {msg && <p className={msg.kind === 'ok' ? 'hint' : 'small alert-text'}>{msg.text}</p>}
    </section>
  );
}

interface DunningSettings {
  actives: boolean;
  blocageRestitutions: boolean;
}

/** FAC-05 : relances automatiques et blocage optionnel des restitutions. */
function DunningSettingsPanel() {
  const [s, setS] = useState<DunningSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<{ relances: DunningSettings }>('/bo/billing/settings')
      .then((r) => setS(r.relances))
      .catch((e) => setError((e as Error).message));
  }, []);
  const save = async (next: DunningSettings) => {
    setBusy(true);
    try {
      const r = await put<{ relances: DunningSettings }>('/bo/billing/settings', { relances: next });
      setS(r.relances);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel">
      <h2>Relances des impayés</h2>
      {!s ? (
        <p className="hint">{error ?? 'Chargement…'}</p>
      ) : (
        <>
          <label className="check">
            <input type="checkbox" checked={s.actives} disabled={busy} onChange={(e) => void save({ ...s, actives: e.target.checked })} />
            Relancer par e-mail 7, 15 et 30 jours après l’échéance
          </label>
          <label className="check">
            <input type="checkbox" checked={s.blocageRestitutions} disabled={busy} onChange={(e) => void save({ ...s, blocageRestitutions: e.target.checked })} />
            Suspendre les restitutions d’un client impayé depuis plus de 30 jours
          </label>
          <p className="hint small">
            Le message part au contact facturation du client, à défaut à ses administrateurs. La suspension des restitutions repose sur le droit de rétention : faites-la valider par votre conseil avant de
            l’activer.
          </p>
          {error && <p className="small alert-text">{error}</p>}
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------------------

interface Line {
  id: string;
  type: string;
  libelle: string;
  quantite: number;
  unite: string;
  prixUnitaireHtCents: number;
  tauxTva: number;
  totalHtCents: number;
}
interface Day {
  date: string;
  m2: number;
  source: string;
  motif: string | null;
}
interface InvoiceDetail extends InvoiceRow {
  conditionsPaiement: string | null;
  tvaCents: number;
  motif: string | null;
  empreinte: string | null;
  bonDeCommande: string | null;
  origineId: string | null;
  m2Inclus: number | null;
  prixMensuelCents: number | null;
  prixM2DepassementCents: number | null;
  prestationsIncluses: Record<string, number> | null;
  modeSurface: string | null;
  lignes: Line[];
  avoirs: { id: string; numero: string; totalHtCents: number; totalTtcCents: number; emiseLe: string; motif: string | null }[];
  paiements: { moyen: string; montantCents: number; date: string; reference: string | null }[];
  jours: Day[];
  historique: { action: string; motif: string | null; le: string; acteur: string | null }[];
  relances: { niveau: number; manuelle: boolean; envoyeeLe: string; destinataires: number; par: string | null }[];
  derniereRelanceLe: string | null;
}

export function InvoiceView({ id }: { id: string }) {
  const [f, setF] = useState<InvoiceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    get<InvoiceDetail>(`/bo/billing/invoices/${id}`)
      .then((r) => setF(r))
      .catch((e) => setError((e as Error).message));
  }, [id]);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>, msg: string | ((r: unknown) => string)) => {
    setBusy(true);
    try {
      const r = await fn();
      setNotice(typeof msg === 'string' ? msg : msg(r));
      setError(null);
      load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (error && !f) return <Banner kind="error">{error}</Banner>;
  if (!f) return <p className="hint">Chargement…</p>;
  const draft = f.statut === 'BROUILLON';
  const avoir = f.type === 'AVOIR';
  const credited = f.avoirs.reduce((s, a) => s - a.totalHtCents, 0);
  const title = avoir ? 'Avoir' : 'Facture';

  return (
    <>
      <a className="back-link" href={href({ name: 'facturation' })}>
        ← Factures et avoirs
      </a>
      <section className="bo-head">
        <div>
          <p className="eyebrow">
            — {title} · <span className="mono">{f.numero ?? 'brouillon'}</span>
          </p>
          <h1>{f.client}</h1>
          <p className="lead cap">
            {avoir ? (
              <>
                Sur la facture{' '}
                <a className="mono" href={href({ name: 'facture', id: f.origineId! })}>
                  {f.origineNumero}
                </a>
                {f.motif ? ` · ${f.motif}` : ''}
              </>
            ) : (
              <>
                {period(f)}
                {f.m2Inclus != null ? ` · forfait ${m2(f.m2Inclus)} à ${euros(f.prixMensuelCents ?? 0)} HT, dépassement ${euros(f.prixM2DepassementCents ?? 0)} HT/m²` : ''}
              </>
            )}
          </p>
        </div>
        <div className="head-status">
          <StatusPill label={statusLabel(f)} tone={invoiceTone(f)} />
        </div>
      </section>

      {notice && <Banner kind="ok">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
      {draft && f.bloquee && <Banner kind="info">Bloquée : {f.motifBlocage}. Elle ne partira pas toute seule.</Banner>}

      <div className="two-col">
        <div className="col-main">
          <section className="panel">
            <h2>Lignes</h2>
            <div className="table-wrap flat">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Désignation</th>
                    <th className="num">Qté</th>
                    <th className="num">PU HT</th>
                    <th className="num">Total HT</th>
                    {draft && <th aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {f.lignes.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.libelle}
                        <div className="muted">
                          {LINE_TYPE[l.type] ?? l.type} · TVA {l.tauxTva} %
                        </div>
                      </td>
                      <td className="num">
                        {l.quantite.toLocaleString('fr-FR')} {l.unite}
                      </td>
                      <td className="num">{euros(l.prixUnitaireHtCents)}</td>
                      <td className="num">{euros(l.totalHtCents)}</td>
                      {draft && (
                        <td className="num">
                          <RemoveLine onRemove={(motif) => act(() => post(`/bo/billing/invoices/${f.id}/lines/${l.id}/remove`, { motif }), 'Ligne retirée.')} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>Total HT</td>
                    <td className="num">{euros(f.totalHtCents)}</td>
                    {draft && <td />}
                  </tr>
                  <tr>
                    <td colSpan={3}>TVA</td>
                    <td className="num">{euros(f.tvaCents)}</td>
                    {draft && <td />}
                  </tr>
                  <tr className="grand">
                    <td colSpan={3}>Total TTC</td>
                    <td className="num">{euros(f.totalTtcCents)}</td>
                    {draft && <td />}
                  </tr>
                </tfoot>
              </table>
            </div>
            {draft && <AddLine onAdd={(body) => act(() => post(`/bo/billing/invoices/${f.id}/lines`, body), 'Ligne ajoutée.')} busy={busy} />}
          </section>

          {f.jours.length > 0 && (
            <section className="panel">
              <h2>Surface relevée chaque jour</h2>
              <p className="muted">
                Surface facturée : <strong>{m2(f.m2Factures)}</strong> ({f.modeSurface === 'PIC' ? 'pic du mois' : 'moyenne des jours'}, arrondie au 0,5 m² supérieur)
                {f.m2Inclus != null ? `, pour ${m2(f.m2Inclus)} inclus.` : '.'}
              </p>
              <SurfaceChart days={f.jours} included={f.m2Inclus} />
            </section>
          )}

          {f.historique.length > 0 && (
            <section className="panel">
              <h2>Historique</h2>
              <ol className="timeline">
                {f.historique.map((h, i) => (
                  <li key={i}>
                    <strong>{AUDIT_ACTION[h.action] ?? h.action}</strong>
                    <span className="muted">
                      {dateFr(h.le)} · {h.acteur ?? 'automatique'}
                      {h.motif ? ` · « ${h.motif} »` : ''}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>

        <aside className="col-side">
          {draft ? (
            <section className="panel callout-panel">
              <h2>Revue du brouillon</h2>
              <p className="muted">
                {f.bloquee ? 'Envoi automatique suspendu.' : `Envoi automatique le ${dateFr(f.emissionPrevue)}.`} À l’émission, la facture reçoit son numéro définitif et son PDF est figé.
              </p>
              <button className="btn primary big" disabled={busy || f.bloquee} onClick={() => void act(() => post<{ numero: string }>(`/bo/billing/invoices/${f.id}/issue`), (r) => `Facture ${(r as { numero: string }).numero} émise.`)}>
                Émettre maintenant
              </button>
              <BlockForm f={f} busy={busy} act={act} />
            </section>
          ) : (
            <section className="panel">
              <h2>Document</h2>
              <dl className="facts">
                <dt>Émis le</dt>
                <dd>{dateFr(f.emiseLe)}</dd>
                {f.echeance && (
                  <>
                    <dt>Échéance</dt>
                    <dd>
                      {dateFr(f.echeance)}
                      {f.conditionsPaiement ? ` (${f.conditionsPaiement})` : ''}
                    </dd>
                  </>
                )}
                {f.payeLe && (
                  <>
                    <dt>Payée le</dt>
                    <dd>{dateFr(f.payeLe)}</dd>
                  </>
                )}
              </dl>
              <button type="button" className="btn primary" onClick={() => void openPdf(`/bo/billing/invoices/${f.id}/pdf`, `${f.numero}.pdf`).catch((e) => setError((e as Error).message))}>
                Ouvrir le PDF
              </button>
              {f.empreinte && (
                <p className="hint fingerprint" title="Empreinte SHA-256 du PDF émis">
                  Empreinte <span className="mono">{f.empreinte.slice(0, 16)}…</span>
                </p>
              )}
            </section>
          )}

          {!avoir && ['EMISE', 'EN_RETARD'].includes(f.statut) && <PaidForm f={f} busy={busy} act={act} />}
          {!avoir && ['EMISE', 'PAYEE', 'EN_RETARD'].includes(f.statut) && <CreditForm f={f} credited={credited} busy={busy} act={act} />}

          {f.avoirs.length > 0 && (
            <section className="panel">
              <h2>Avoirs</h2>
              <ul className="plain">
                {f.avoirs.map((a) => (
                  <li key={a.id}>
                    <a className="mono" href={href({ name: 'facture', id: a.id })}>
                      {a.numero}
                    </a>
                    <span className="muted">
                      {euros(a.totalHtCents)} HT · {dateShort(a.emiseLe)}
                      {a.motif ? ` · ${a.motif}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {f.type === 'FACTURE' && (['EMISE', 'EN_RETARD'].includes(f.statut) || f.relances.length > 0) && (
            <section className="panel">
              <h2>Relances</h2>
              {f.relances.length === 0 ? (
                <p className="hint">Aucune relance pour l’instant. Les relances automatiques partent 7, 15 et 30 jours après l’échéance.</p>
              ) : (
                <ul className="plain">
                  {f.relances.map((r, i) => (
                    <li key={i}>
                      <strong>{r.manuelle ? 'Relance manuelle' : `Relance ${r.niveau}/3`}</strong>
                      <span className="muted">
                        {dateShort(r.envoyeeLe)} · {r.destinataires} destinataire{r.destinataires > 1 ? 's' : ''}
                        {r.par ? ` · ${r.par}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {['EMISE', 'EN_RETARD'].includes(f.statut) && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void act(() => post<{ destinataires: number }>(`/bo/billing/invoices/${f.id}/remind`), (r) => `Relance envoyée à ${(r as { destinataires: number }).destinataires} destinataire(s).`)}
                >
                  Relancer maintenant
                </button>
              )}
            </section>
          )}
          {f.paiements.length > 0 && (
            <section className="panel">
              <h2>Paiements</h2>
              <ul className="plain">
                {f.paiements.map((p, i) => (
                  <li key={i}>
                    <strong>{euros(p.montantCents)}</strong>
                    <span className="muted">
                      {p.moyen.toLowerCase()} · {dateShort(p.date)}
                      {p.reference ? ` · ${p.reference}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </>
  );
}

type Act = (fn: () => Promise<unknown>, msg: string | ((r: unknown) => string)) => Promise<boolean>;

function BlockForm({ f, busy, act }: { f: InvoiceDetail; busy: boolean; act: Act }) {
  const [open, setOpen] = useState(false);
  const [motif, setMotif] = useState('');
  if (f.bloquee) {
    return (
      <button type="button" className="btn" disabled={busy} onClick={() => void act(() => post(`/bo/billing/invoices/${f.id}/block`, { bloquee: false }), 'Brouillon débloqué : il partira à la date prévue.')}>
        Débloquer
      </button>
    );
  }
  return !open ? (
    <button type="button" className="link" onClick={() => setOpen(true)}>
      Bloquer l’envoi automatique
    </button>
  ) : (
    <form
      className="stack counter"
      onSubmit={(e) => {
        e.preventDefault();
        void act(() => post(`/bo/billing/invoices/${f.id}/block`, { bloquee: true, motif }), 'Brouillon bloqué.').then((ok) => ok && setOpen(false));
      }}
    >
      <label>
        Pourquoi ?
        <input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Surface à vérifier avec le client" required minLength={3} maxLength={500} />
      </label>
      <div className="row-actions">
        <button className="btn" disabled={busy}>
          Bloquer
        </button>
        <button type="button" className="btn ghost-dark" onClick={() => setOpen(false)}>
          Annuler
        </button>
      </div>
    </form>
  );
}

function PaidForm({ f, busy, act }: { f: InvoiceDetail; busy: boolean; act: Act }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [moyen, setMoyen] = useState('VIREMENT');
  const [reference, setReference] = useState('');
  return (
    <section className="panel">
      <h2>Paiement reçu</h2>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => post(`/bo/billing/invoices/${f.id}/paid`, { date, moyen, ...(reference ? { reference } : {}) }), 'Paiement enregistré.');
        }}
      >
        <div className="row">
          <label>
            Reçu le
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <label>
            Moyen
            <select value={moyen} onChange={(e) => setMoyen(e.target.value)}>
              <option value="VIREMENT">Virement</option>
              <option value="SEPA">Prélèvement SEPA</option>
              <option value="CB">Carte bancaire</option>
              <option value="CHEQUE">Chèque</option>
            </select>
          </label>
        </div>
        <label>
          Référence (facultatif)
          <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
        </label>
        <button className="btn" disabled={busy}>
          Marquer payée ({euros(f.totalTtcCents)})
        </button>
      </form>
    </section>
  );
}

function CreditForm({ f, credited, busy, act }: { f: InvoiceDetail; credited: number; busy: boolean; act: Act }) {
  const [open, setOpen] = useState(false);
  const [total, setTotal] = useState(true);
  const [amount, setAmount] = useState('');
  const [motif, setMotif] = useState('');
  const left = f.totalHtCents - credited;
  if (left <= 0) return null;
  const cents = total ? left : parseEuros(amount);
  return (
    <section className="panel">
      <h2>Corriger par un avoir</h2>
      {!open ? (
        <>
          <p className="muted">Une facture émise ne se modifie pas. Un avoir annule tout ou partie du montant ; un avoir du solde annule la facture et permet de refacturer la période.</p>
          <button type="button" className="btn" onClick={() => setOpen(true)}>
            Émettre un avoir
          </button>
        </>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!cents || cents <= 0) return;
            void act(
              () => post<{ numero: string }>(`/bo/billing/invoices/${f.id}/credit`, { motif, ...(total ? {} : { montantHtCents: cents }) }),
              (r) => `Avoir ${(r as { numero: string }).numero} émis.`,
            ).then((ok) => ok && setOpen(false));
          }}
        >
          <div className="pills" role="radiogroup" aria-label="Montant de l’avoir">
            <button type="button" role="radio" aria-checked={total} className={total ? 'active' : ''} onClick={() => setTotal(true)}>
              Solde ({euros(left)} HT)
            </button>
            <button type="button" role="radio" aria-checked={!total} className={!total ? 'active' : ''} onClick={() => setTotal(false)}>
              Montant partiel
            </button>
          </div>
          {!total && (
            <label>
              Montant HT à créditer (€)
              <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="150,00" required />
              {amount && cents == null && <span className="form-error">Montant illisible</span>}
              {cents != null && cents > left && <span className="form-error">Au plus {euros(left)} HT</span>}
            </label>
          )}
          <label>
            Motif (figure sur l’avoir)
            <input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Livraison du 26 offerte" required minLength={3} maxLength={500} />
          </label>
          <div className="row-actions">
            <button className="btn primary" disabled={busy || !cents || cents <= 0 || cents > left}>
              Émettre l’avoir{cents ? ` de ${euros(cents)} HT` : ''}
            </button>
            <button type="button" className="btn ghost-dark" onClick={() => setOpen(false)}>
              Annuler
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function AddLine({ onAdd, busy }: { onAdd: (b: unknown) => Promise<boolean>; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [libelle, setLibelle] = useState('');
  const [quantite, setQuantite] = useState('1');
  const [unite, setUnite] = useState('forfait');
  const [prix, setPrix] = useState('');
  const [motif, setMotif] = useState('');
  const cents = parseEuros(prix);
  const qty = Number(quantite.replace(',', '.'));
  if (!open)
    return (
      <button type="button" className="link" onClick={() => setOpen(true)}>
        Ajouter une ligne (prestation ponctuelle, geste commercial)
      </button>
    );
  return (
    <form
      className="stack counter"
      onSubmit={(e) => {
        e.preventDefault();
        if (cents == null || !(qty > 0)) return;
        void onAdd({ libelle, quantite: qty, unite, prixUnitaireHtCents: cents, tauxTva: 20, motif }).then((ok) => {
          if (!ok) return;
          setOpen(false);
          setLibelle('');
          setPrix('');
          setMotif('');
        });
      }}
    >
      <label>
        Désignation
        <input value={libelle} onChange={(e) => setLibelle(e.target.value)} required minLength={2} maxLength={200} placeholder="Photo à la demande" />
      </label>
      <div className="row">
        <label>
          Quantité
          <input inputMode="decimal" value={quantite} onChange={(e) => setQuantite(e.target.value)} required />
        </label>
        <label>
          Unité
          <input value={unite} onChange={(e) => setUnite(e.target.value)} required maxLength={30} />
        </label>
        <label>
          Prix unitaire HT (€)
          <input inputMode="decimal" value={prix} onChange={(e) => setPrix(e.target.value)} required placeholder="15,00 ou -50,00" />
        </label>
      </div>
      <label>
        Motif (journal d’audit)
        <input value={motif} onChange={(e) => setMotif(e.target.value)} required minLength={3} maxLength={500} placeholder="Demande du client du 12" />
      </label>
      <div className="row-actions">
        <button className="btn" disabled={busy || cents == null || !(qty > 0)}>
          Ajouter
        </button>
        <button type="button" className="btn ghost-dark" onClick={() => setOpen(false)}>
          Annuler
        </button>
      </div>
    </form>
  );
}

function RemoveLine({ onRemove }: { onRemove: (motif: string) => Promise<boolean> }) {
  const [asking, setAsking] = useState(false);
  const [motif, setMotif] = useState('');
  if (!asking)
    return (
      <button type="button" className="btn small ghost-dark" onClick={() => setAsking(true)} aria-label="Retirer la ligne">
        Retirer
      </button>
    );
  return (
    <form
      className="assign"
      onSubmit={(e) => {
        e.preventDefault();
        void onRemove(motif).then((ok) => ok && setAsking(false));
      }}
    >
      <input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Motif" required minLength={3} aria-label="Motif du retrait" autoFocus />
      <button className="btn small">OK</button>
    </form>
  );
}

/**
 * Surface relevée chaque jour : barres fines (une série, donc pas de légende), ligne de référence des m² inclus,
 * info-bulle par jour et tableau consultable.
 */
export function SurfaceChart({ days, included }: { days: Day[]; included: number | null }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 180;
  const pad = { l: 40, r: 8, t: included != null ? 26 : 10, b: 22 };
  const max = niceTicks(Math.max(...days.map((d) => d.m2), included ?? 0, 1) * 1.05).at(-1)!;
  const step = (W - pad.l - pad.r) / days.length;
  const bw = Math.max(2, Math.min(14, step - 2));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = niceTicks(max);
  const h = hover != null ? days[hover] : null;
  return (
    <figure className="chart">
      <div className="chart-tip" aria-live="polite">
        {h ? (
          <>
            <strong>{m2(h.m2)}</strong> le {dateFr(h.date)}
            {h.source !== 'AUTO' ? ` · ${SNAPSHOT_SOURCE[h.source] ?? h.source}` : ''}
          </>
        ) : (
          <span className="muted">Survolez un jour pour le détail.</span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Surface occupée par jour, de ${dateFr(days[0]!.date)} à ${dateFr(days[days.length - 1]!.date)}`} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="axis">
              {t.toLocaleString('fr-FR')}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = pad.l + i * step + (step - bw) / 2;
          const top = y(d.m2);
          const base = y(0);
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)}>
              <rect x={pad.l + i * step} y={pad.t} width={step} height={base - pad.t} fill="transparent" />
              <path
                d={`M${x},${base} V${top + Math.min(4, (base - top) / 2)} q0,-${Math.min(4, (base - top) / 2)} ${bw / 2},-${Math.min(4, (base - top) / 2)} q${bw / 2},0 ${bw / 2},${Math.min(4, (base - top) / 2)} V${base} Z`}
                className={`bar${d.source === 'CORRECTION' ? ' corrected' : ''}${hover === i ? ' on' : ''}`}
              />
            </g>
          );
        })}
        {included != null && (
          <g>
            <line x1={pad.l} x2={W - pad.r} y1={y(included)} y2={y(included)} className="ref" />
            {/* clé de la ligne de référence, au-dessus de la zone de tracé pour ne jamais chevaucher les barres */}
            <line x1={W - pad.r - 100} x2={W - pad.r - 82} y1={9} y2={9} className="ref" />
            <text x={W - pad.r} y={13} textAnchor="end" className="ref-label">
              {m2(included)} inclus
            </text>
          </g>
        )}
        {[0, days.length - 1].map((i) => (
          <text key={i} x={pad.l + i * step + step / 2} y={H - 6} textAnchor={i === 0 ? 'start' : 'end'} className="axis">
            {dateShort(days[i]!.date)}
          </text>
        ))}
      </svg>
      <details>
        <summary>Voir le tableau des {days.length} jours</summary>
        <table className="table compact">
          <thead>
            <tr>
              <th>Jour</th>
              <th className="num">Surface</th>
              <th>Origine</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.date}>
                <td>{dateFr(d.date)}</td>
                <td className="num">{m2(d.m2)}</td>
                <td>
                  {SNAPSHOT_SOURCE[d.source] ?? d.source}
                  {d.motif ? <div className="muted">{d.motif}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

/** Graduations rondes (1, 2, 2,5 ou 5 × 10^n) couvrant 0 → max. */
function niceTicks(max: number): number[] {
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * pow >= raw) ?? 10) * pow;
  const out: number[] = [];
  for (let v = 0; v < max + step * 0.999; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}
