import { useEffect, useMemo, useState } from 'react';
import { apiBlob, get, post, saveBlob } from '../lib/api';
import { hashParam } from '../lib/router';
import { dateFr, euros, type BillingEstimate, type Ctx } from '../lib/types';
import { Banner, Pills, StatusPill } from '../components/ui';

/** SUI-03 : BL signés, factures et avoirs, filtrables par type, projet et période ; PDF figés, téléchargement groupé. */

interface Doc {
  id: string;
  type: 'FACTURE' | 'AVOIR' | 'BL';
  numero: string;
  date: string;
  statut?: string;
  periodeDebut?: string | null;
  periodeFin?: string | null;
  totalHtCents?: number;
  totalTtcCents?: number;
  echeance?: string | null;
  origineNumero?: string | null;
  typeBl?: string;
  commande?: string | null;
  typeCommande?: string;
  projet?: string | null;
  nbReserves?: number;
  /** LIV-05 : déposé sans signature */
  nonSigne?: boolean;
}

type Filter = '' | 'FACTURE' | 'AVOIR' | 'BL';

const BL_LABEL: Record<string, string> = { LIVRAISON: 'Bon de livraison', RETRAIT: 'Bon de retrait', REFUS: 'Livraison refusée', ENLEVEMENT: 'Bon d’enlèvement' };
const INVOICE_STATUS: Record<string, string> = { EMISE: 'À régler', PAYEE: 'Payée', EN_RETARD: 'En retard', ANNULEE: 'Annulée par avoir' };

const title = (d: Doc) =>
  d.type === 'BL' ? `${BL_LABEL[d.typeBl ?? ''] ?? 'Bon de livraison'}${d.nonSigne ? ' (non signé, déposé)' : ''}` : d.type === 'AVOIR' ? 'Avoir' : 'Facture';
const monthOf = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
const pathOf = (d: Doc) => `/me/documents/${d.type.toLowerCase()}/${d.id}/pdf`;

export function Documents({ ctx, role }: { ctx: Ctx; role: string }) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [showsInvoices, setShowsInvoices] = useState(true);
  const [type, setType] = useState<Filter>('');
  const [projet, setProjet] = useState('');
  const [du, setDu] = useState('');
  const [au, setAu] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // ADM-04 : le titulaire du compte peut régler une facture en ligne (Stripe)
  const [canPay, setCanPay] = useState(false);
  const paidBack = hashParam('paiement') === 'ok';
  const [estimate, setEstimate] = useState<BillingEstimate | null>(null);

  useEffect(() => {
    if (role !== 'B2B_ADMIN' && role !== 'B2C') return;
    get<{ paiementEnLigne: boolean }>('/me/billing')
      .then((b) => setCanPay(b.paiementEnLigne))
      .catch(() => setCanPay(false));
    get<BillingEstimate>('/me/billing/estimate')
      .then(setEstimate)
      .catch(() => setEstimate(null));
  }, [role]);

  const pay = async (d: Doc) => {
    setBusy(`pay:${d.id}`);
    try {
      const r = await post<{ url: string }>(`/me/invoices/${d.id}/pay`);
      window.location.assign(r.url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  useEffect(() => {
    const p = new URLSearchParams();
    if (type) p.set('type', type);
    if (projet) p.set('projet', projet);
    if (du) p.set('du', du);
    if (au) p.set('au', au);
    get<{ items: Doc[]; factures: boolean }>(`/me/documents?${p}`)
      .then((r) => {
        setDocs(r.items);
        setShowsInvoices(r.factures);
        setSelected(new Set());
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [type, projet, du, au]);

  const key = (d: Doc) => `${d.type}:${d.id}`;
  const chosen = useMemo(() => (docs ?? []).filter((d) => selected.has(key(d))), [docs, selected]);
  const toggle = (d: Doc) => {
    const next = new Set(selected);
    if (next.has(key(d))) next.delete(key(d));
    else next.add(key(d));
    setSelected(next);
  };

  const download = async (d: Doc) => {
    setBusy(key(d));
    try {
      saveBlob(await apiBlob(pathOf(d)), `${d.numero}.pdf`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const downloadZip = async (list: Doc[]) => {
    setBusy('zip');
    try {
      const blob = await apiBlob('/me/documents/zip', { method: 'POST', body: JSON.stringify({ items: list.slice(0, 50).map((d) => ({ type: d.type, id: d.id })) }) });
      saveBlob(blob, `jamystock-documents-${new Date().toISOString().slice(0, 10)}.zip`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const unpaid = (docs ?? []).filter((d) => d.type === 'FACTURE' && (d.statut === 'EMISE' || d.statut === 'EN_RETARD'));

  return (
    <>
      <section className="page-head">
        <span className="eyebrow">— Archives</span>
        <h1>Mes documents</h1>
        <p className="lead">
          {showsInvoices ? 'Bons de livraison signés, factures et avoirs' : 'Bons de livraison signés de vos projets'}, en PDF horodaté. Un document émis n’est jamais modifié.
        </p>
      </section>

      {paidBack && <Banner kind="ok">Paiement transmis : la facture passe en « Payée » dès que la banque l’a confirmé.</Banner>}
      {showsInvoices && unpaid.length > 0 && (
        <Banner kind="info">
          {unpaid.length === 1 ? 'Une facture est' : `${unpaid.length} factures sont`} à régler pour un total de {euros(unpaid.reduce((s, d) => s + (d.totalTtcCents ?? 0), 0))} TTC.
        </Banner>
      )}

      {estimate && estimate.factures.length > 0 && <EstimateCard e={estimate} />}

      <section className="doc-filters" aria-label="Filtres">
        <Pills<Filter>
          label="Type de document"
          value={type}
          onChange={setType}
          options={[
            { value: '', label: 'Tous' },
            ...(showsInvoices
              ? [
                  { value: 'FACTURE' as const, label: 'Factures' },
                  { value: 'AVOIR' as const, label: 'Avoirs' },
                ]
              : []),
            { value: 'BL', label: 'Bons de livraison' },
          ]}
        />
        {ctx.projets.length > 0 && (
          <select aria-label="Projet" value={projet} onChange={(e) => setProjet(e.target.value)}>
            <option value="">Tous les projets</option>
            {ctx.projets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.nom}
              </option>
            ))}
          </select>
        )}
        <span className="date-range">
          <label className="inline">
            Du <input type="date" value={du} onChange={(e) => setDu(e.target.value)} />
          </label>
          <label className="inline">
            au <input type="date" value={au} onChange={(e) => setAu(e.target.value)} />
          </label>
        </span>
      </section>
      {projet && showsInvoices && <p className="hint">Les factures couvrent tout le compte : avec un projet choisi, seuls ses bons de livraison sont listés.</p>}

      {error && <Banner kind="error">{error}</Banner>}
      {!docs ? (
        !error && <p className="hint">Chargement…</p>
      ) : docs.length === 0 ? (
        <p className="empty">Aucun document pour ces critères.</p>
      ) : (
        <>
          <div className="doc-actions">
            <label className="inline check">
              <input
                type="checkbox"
                checked={chosen.length === docs.length}
                onChange={(e) => setSelected(e.target.checked ? new Set(docs.map(key)) : new Set())}
              />{' '}
              Tout sélectionner
            </label>
            <span className="spacer" />
            <button type="button" className="btn primary small" disabled={!!busy} onClick={() => void downloadZip(chosen.length ? chosen : docs)}>
              {busy === 'zip' ? 'Préparation…' : chosen.length ? `Télécharger la sélection (${chosen.length}) en ZIP` : `Tout télécharger en ZIP (${Math.min(docs.length, 50)})`}
            </button>
          </div>
          <ul className="doc-list">
            {docs.map((d) => (
              <li key={key(d)} className={selected.has(key(d)) ? 'on' : ''}>
                <input type="checkbox" checked={selected.has(key(d))} onChange={() => toggle(d)} aria-label={`Sélectionner ${d.numero}`} />
                <span className={`doc-icon t-${d.type.toLowerCase()}`} aria-hidden="true">
                  {d.type === 'BL' ? 'BL' : d.type === 'AVOIR' ? 'AV' : 'FA'}
                </span>
                <span className="doc-main">
                  <strong>{title(d)}</strong>
                  <span className="mono">{d.numero}</span>
                </span>
                <span className="doc-meta">
                  {d.type === 'BL' ? (
                    <>
                      {d.commande ? `Demande ${d.commande}` : ''}
                      {d.projet ? ` · ${d.projet}` : ''}
                      {d.nbReserves ? ` · ${d.nbReserves} réserve${d.nbReserves > 1 ? 's' : ''}` : ''}
                    </>
                  ) : d.type === 'AVOIR' ? (
                    <>Sur la facture {d.origineNumero}</>
                  ) : (
                    <span className="cap">{d.periodeDebut ? monthOf(d.periodeDebut) : ''}</span>
                  )}
                  <span className="doc-date">{d.type === 'BL' ? `${d.nonSigne ? 'Déposé' : 'Signé'} le ${dateFr(d.date)}` : `Émise le ${dateFr(d.date)}`}</span>
                </span>
                <span className="doc-amount">
                  {d.totalTtcCents != null && <strong>{euros(d.totalTtcCents)}</strong>}
                  {d.type === 'FACTURE' && d.statut && (
                    <StatusPill label={INVOICE_STATUS[d.statut] ?? d.statut} tone={d.statut === 'EMISE' ? 'accent' : d.statut === 'EN_RETARD' ? 'alert' : d.statut === 'PAYEE' ? 'ok' : 'neutral'} />
                  )}
                  {d.type === 'FACTURE' && d.statut === 'EMISE' && d.echeance && <span className="doc-date">avant le {dateFr(d.echeance)}</span>}
                  {canPay && d.type === 'FACTURE' && (d.statut === 'EMISE' || d.statut === 'EN_RETARD') && (
                    <button type="button" className="btn primary small" disabled={!!busy} onClick={() => void pay(d)}>
                      {busy === `pay:${d.id}` ? '…' : 'Payer en ligne'}
                    </button>
                  )}
                </span>
                <button type="button" className="btn small" disabled={!!busy} onClick={() => void download(d)}>
                  {busy === key(d) ? '…' : 'PDF'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** ADM-02 : estimation de la prochaine facture, recalculée à chaque visite. */
function EstimateCard({ e }: { e: BillingEstimate }) {
  const [open, setOpen] = useState(false);
  const month = monthOf(`${e.mois}-01`);
  const projected = e.factures.reduce((s, f) => s + f.joursProjetes, 0) > 0;
  return (
    <section className="bill-estimate">
      <div className="bill-estimate-main">
        <span className="eyebrow">— Prochaine facture</span>
        <p className="bill-estimate-amount">
          <strong>{euros(e.totalTtcCents)}</strong> <span>TTC estimés</span>
        </p>
        <p className="hint small">
          <span className="cap">{month}</span>, émission prévue le {dateFr(e.emissionPrevue)}.{' '}
          {projected ? `Projection avec votre surface actuelle (${e.surfaceActuelle.toLocaleString('fr-FR')} m²) jusqu’à la fin du mois.` : 'Mois complet relevé.'}
        </p>
      </div>
      <button type="button" className="btn small" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Masquer le détail' : 'Voir le détail'}
      </button>
      {open && (
        <div className="bill-estimate-detail">
          {e.factures.map((f) => (
            <table key={f.periodeDebut} className="bill-estimate-table">
              <caption>
                Du {dateFr(f.periodeDebut)} au {dateFr(f.periodeFin)} · {f.joursReleves} jour{f.joursReleves > 1 ? 's' : ''} relevé{f.joursReleves > 1 ? 's' : ''}
                {f.joursProjetes ? `, ${f.joursProjetes} projeté${f.joursProjetes > 1 ? 's' : ''}` : ''}
              </caption>
              <tbody>
                {f.lignes.map((l, i) => (
                  <tr key={i}>
                    <td>{l.libelle}</td>
                    <td className="num">{euros(l.totalHtCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total HT</td>
                  <td className="num">{euros(f.totalHtCents)}</td>
                </tr>
                <tr>
                  <td>TVA</td>
                  <td className="num">{euros(f.tvaCents)}</td>
                </tr>
              </tfoot>
            </table>
          ))}
          <p className="hint small">Estimation indicative : la facture définitive reprend les relevés quotidiens réels et les prestations réalisées d’ici la fin du mois.</p>
        </div>
      )}
    </section>
  );
}
