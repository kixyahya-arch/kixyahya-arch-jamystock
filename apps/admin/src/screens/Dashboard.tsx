import { useEffect, useMemo, useState } from 'react';
import { get } from '../lib/api';
import { href } from '../lib/router';
import type { BoContext, OrderRow, Summary } from '../lib/types';
import { ORDER_STATUS, ORDER_TYPE, dateShort } from '../lib/labels';
import { Banner, Pills, StatusPill, Tile, Urgent, orderTone } from '../components/ui';

/** FLX-01 : colonnes du Kanban, de ce qui attend le dépôt à ce qui est terminé. */
const COLUMNS: { key: string; label: string; statuts: string[] }[] = [
  { key: 'validation', label: 'En validation chez le client', statuts: ['EN_ATTENTE_VALIDATION'] },
  { key: 'confirmer', label: 'À confirmer', statuts: ['SOUMISE'] },
  { key: 'planifiees', label: 'Planifiées', statuts: ['PLANIFIEE'] },
  { key: 'preparation', label: 'En préparation', statuts: ['EN_PREPARATION', 'PRETE'] },
  { key: 'route', label: 'En route', statuts: ['EN_LIVRAISON'] },
  { key: 'terminees', label: 'Terminées', statuts: ['LIVREE', 'LIVREE_AVEC_RESERVES', 'RETIREE', 'COLLECTEE', 'STOCKEE', 'CLOTUREE', 'ECHEC_LIVRAISON', 'REFUSEE', 'ANNULEE'] },
];

type View = 'kanban' | 'liste';
type TypeFilter = '' | 'LIVRAISON' | 'RETRAIT' | 'COLLECTE';

const VIEW_KEY = 'jamystock.admin.vue';
const loadView = (): View => {
  try {
    return localStorage.getItem(VIEW_KEY) === 'liste' ? 'liste' : 'kanban';
  } catch {
    return 'kanban';
  }
};

export function Dashboard({ ctx }: { ctx: BoContext }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(loadView);
  const [type, setType] = useState<TypeFilter>('');
  const [client, setClient] = useState('');
  const [depot, setDepot] = useState('');
  const [du, setDu] = useState('');
  const [au, setAu] = useState('');
  const [q, setQ] = useState('');
  const [urgentOnly, setUrgentOnly] = useState(false);

  useEffect(() => {
    get<Summary>('/bo/summary').then(setSummary).catch(() => undefined);
  }, []);

  useEffect(() => {
    const p = new URLSearchParams();
    if (type) p.set('type', type);
    if (client) p.set('client', client);
    if (depot) p.set('depot', depot);
    if (du) p.set('du', du);
    if (au) p.set('au', au);
    if (q.trim()) p.set('q', q.trim());
    const t = setTimeout(() => {
      get<{ items: OrderRow[] }>(`/bo/orders?${p}`)
        .then((r) => {
          setOrders(r.items);
          setError(null);
        })
        .catch((e) => setError((e as Error).message));
    }, 200);
    return () => clearTimeout(t);
  }, [type, client, depot, du, au, q]);

  const shown = useMemo(() => (orders ?? []).filter((o) => !urgentOnly || o.urgent), [orders, urgentOnly]);

  const changeView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* préférence non mémorisée */
    }
  };

  return (
    <>
      <section className="bo-head">
        <div>
          <p className="eyebrow">— Dispatch</p>
          <h1>Demandes</h1>
        </div>
        <a className="btn primary" href={href({ name: 'planning' })}>
          Ouvrir le planning
        </a>
      </section>

      {summary && (
        <section className="tiles" aria-label="Chiffres du jour">
          <Tile n={summary.aConfirmer} label="à confirmer" accent={summary.aConfirmer > 0} />
          <Tile n={summary.urgentes} label="urgentes (moins de 48 h)" alert={summary.urgentes > 0} onClick={() => setUrgentOnly(true)} />
          <Tile n={summary.missionsAAffecter} label="missions à affecter" href={href({ name: 'planning' })} />
          <Tile n={summary.missionsDuJour} label="missions aujourd’hui" />
          <Tile n={summary.articlesEnStock} label="biens au dépôt" href={href({ name: 'stock' })} />
          <Tile n={summary.clients} label="clients actifs" href={href({ name: 'clients' })} />
        </section>
      )}

      <section className="toolbar" aria-label="Filtres">
        <Pills<TypeFilter>
          label="Type de demande"
          value={type}
          onChange={setType}
          options={[
            { value: '', label: 'Toutes' },
            { value: 'LIVRAISON', label: 'Livraisons' },
            { value: 'RETRAIT', label: 'Retraits' },
            { value: 'COLLECTE', label: 'Collectes' },
          ]}
        />
        <input className="search" type="search" placeholder="N°, client ou projet…" aria-label="Rechercher une demande" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Client" value={client} onChange={(e) => setClient(e.target.value)}>
          <option value="">Tous les clients</option>
          {ctx.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nom}
            </option>
          ))}
        </select>
        {ctx.depots.length > 1 && (
          <select aria-label="Dépôt" value={depot} onChange={(e) => setDepot(e.target.value)}>
            <option value="">Tous les dépôts</option>
            {ctx.depots.map((d) => (
              <option key={d.id} value={d.id}>
                {d.nom}
              </option>
            ))}
          </select>
        )}
        <label className="inline">
          Du <input type="date" value={du} onChange={(e) => setDu(e.target.value)} />
        </label>
        <label className="inline">
          au <input type="date" value={au} onChange={(e) => setAu(e.target.value)} />
        </label>
        <label className="inline check">
          <input type="checkbox" checked={urgentOnly} onChange={(e) => setUrgentOnly(e.target.checked)} /> Urgentes seulement
        </label>
        <span className="spacer" />
        <Pills<View>
          label="Affichage"
          value={view}
          onChange={changeView}
          options={[
            { value: 'kanban', label: 'Tableau' },
            { value: 'liste', label: 'Liste' },
          ]}
        />
      </section>

      {error && <Banner kind="error">{error}</Banner>}
      {!orders ? (
        !error && <p className="hint">Chargement…</p>
      ) : shown.length === 0 ? (
        <p className="empty">Aucune demande ne correspond à ces filtres.</p>
      ) : view === 'kanban' ? (
        <div className="kanban">
          {COLUMNS.map((col) => {
            const items = shown.filter((o) => col.statuts.includes(o.statut));
            return (
              <section key={col.key} className="kcol" aria-label={col.label}>
                <h2>
                  {col.label} <span className="kcount">{items.length}</span>
                </h2>
                {items.map((o) => (
                  <OrderCard key={o.id} o={o} />
                ))}
              </section>
            );
          })}
        </div>
      ) : (
        <OrderTable orders={shown} />
      )}
    </>
  );
}

const when = (o: OrderRow) => {
  if (o.dateConfirmee) return `Confirmée ${dateShort(o.dateConfirmee)}${o.creneauConfirme ? ` · ${o.creneauConfirme}` : ''}`;
  if (o.dateContreProposee) return `Proposé ${dateShort(o.dateContreProposee)} (attente client)`;
  return `Souhaitée ${dateShort(o.dateSouhaitee)}${o.creneauSouhaite ? ` · ${o.creneauSouhaite}` : ''}`;
};

function OrderCard({ o }: { o: OrderRow }) {
  return (
    <a className={`kcard${o.urgent ? ' is-urgent' : ''}`} href={href({ name: 'demande', id: o.id })}>
      <div className="kcard-top">
        <span className="mono">{o.numero}</span>
        {o.urgent && <Urgent />}
      </div>
      <strong>{o.client}</strong>
      {o.projet && <span className="muted">{o.projet}</span>}
      <span className="ktype">
        {ORDER_TYPE[o.type] ?? o.type} · {o.type === 'COLLECTE' ? 'à collecter' : `${o.nbLignes} bien${o.nbLignes > 1 ? 's' : ''}`}
      </span>
      <span className="kwhen">{when(o)}</span>
      {o.missionsAAffecter > 0 && <span className="kwarn">{o.missionsAAffecter} mission{o.missionsAAffecter > 1 ? 's' : ''} à affecter</span>}
    </a>
  );
}

function OrderTable({ orders }: { orders: OrderRow[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>N°</th>
            <th>Client</th>
            <th>Type</th>
            <th>Date</th>
            <th>Adresse</th>
            <th>Biens</th>
            <th>Statut</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} className={o.urgent ? 'is-urgent' : undefined}>
              <td>
                <a className="mono" href={href({ name: 'demande', id: o.id })}>
                  {o.numero}
                </a>
                {o.urgent && <Urgent />}
              </td>
              <td>
                {o.client}
                {o.projet && <div className="muted">{o.projet}</div>}
              </td>
              <td>{ORDER_TYPE[o.type] ?? o.type}</td>
              <td>{when(o)}</td>
              <td>{o.type === 'RETRAIT' ? 'Au dépôt' : (o.adresse ?? '—')}</td>
              <td>{o.type === 'COLLECTE' ? '—' : o.nbLignes}</td>
              <td>
                <StatusPill label={ORDER_STATUS[o.statut] ?? o.statut} tone={orderTone(o.statut)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
