import { useCallback, useEffect, useState } from 'react';
import { get, post } from '../lib/api';
import { ARTICLE_STATUS, dateFr, timeFr } from '../lib/labels';
import { href } from '../lib/router';
import { Banner, Pills, StatusPill, Tile } from '../components/ui';
import { DepotTabs } from './Warehouse';

/** WMS-04 : plan du dépôt et occupation ; WMS-05 : inventaires tournants et arbitrage des écarts. */

type Fill = 'LIBRE' | 'PARTIEL' | 'PLEIN' | 'INDISPONIBLE';
const FILL: Record<Fill, string> = { LIBRE: 'Libre', PARTIEL: 'Partiel', PLEIN: 'Plein', INDISPONIBLE: 'Indisponible' };
const ZONE_TYPE: Record<string, string> = { STOCKAGE: 'Stockage', RECEPTION: 'Réception', EXPEDITION: 'Expédition', QUARANTAINE: 'Quarantaine' };
const pct = (x: number | null) => (x == null ? '—' : `${Math.round(x * 100)} %`);
const m2 = (x: number) => `${x.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} m²`;

interface PlanLoc {
  id: string;
  code: string;
  chemin: string;
  surfaceM2: number;
  occupeM2: number;
  nbArticles: number;
  etat: Fill;
}
interface PlanZone {
  id: string;
  code: string;
  nom: string;
  type: string;
  surfaceM2: number;
  occupeM2: number;
  taux: number | null;
  etat: Fill;
  nbEmplacements: number;
  libres: number;
  partiels: number;
  pleins: number;
  indisponibles: number;
  nbArticles: number;
  nbClients: number;
  inventaire: { id: string; numero: string; statut: string } | null;
  emplacements: PlanLoc[];
}
interface Plan {
  depot: { id: string; nom: string; code: string };
  zones: PlanZone[];
}
interface Contents {
  zone: { id: string; code: string; nom: string };
  clients: { entrepriseId: string; client: string; nbArticles: number; projets: string[] }[];
  articles: { id: string; qrCode: string; libelle: string; statut: string; client: string; projet: string | null; emplacementCode: string; umQr: string | null }[];
}

export function DepotPlan({ id }: { id: string }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      get<Plan>(`/bo/warehouse/depots/${id}/plan`).then(
        (p) => {
          setPlan(p);
          setZoneId((z) => z ?? p.zones.find((x) => x.type === 'STOCKAGE')?.id ?? p.zones[0]?.id ?? null);
        },
        (e) => setError((e as Error).message),
      ),
    [id],
  );
  useEffect(() => void load(), [load]);

  if (!plan) return error ? <Banner kind="error">{error}</Banner> : <p className="hint">Chargement…</p>;
  const zone = plan.zones.find((z) => z.id === zoneId) ?? null;
  const all = plan.zones.flatMap((z) => z.emplacements);
  const surface = plan.zones.reduce((s, z) => s + z.surfaceM2, 0);
  const occupe = plan.zones.reduce((s, z) => s + z.occupeM2, 0);

  return (
    <>
      <a className="back" href={href({ name: 'depot', id })}>
        ← {plan.depot.nom}
      </a>
      <section className="page-head">
        <span className="eyebrow">
          — Plan du dépôt · <span className="mono">{plan.depot.code}</span>
        </span>
        <h1>Occupation</h1>
        <p className="lead">Chaque zone et chaque emplacement selon la surface au sol occupée. Cliquez sur une zone pour voir ses clients et ses biens.</p>
      </section>
      <div className="tiles">
        <Tile n={pct(surface ? occupe / surface : null)} label={`occupé (${m2(occupe)} sur ${m2(surface)})`} accent />
        <Tile n={all.filter((l) => l.etat === 'LIBRE').length} label="emplacements libres" />
        <Tile n={all.filter((l) => l.etat === 'PARTIEL').length} label="partiels" />
        <Tile n={all.filter((l) => l.etat === 'PLEIN').length} label="pleins" />
      </div>
      <Legend />
      <div className="zone-grid">
        {plan.zones.map((z) => (
          <button key={z.id} type="button" className={`zone-card fill-${z.etat}${z.id === zoneId ? ' selected' : ''}`} aria-pressed={z.id === zoneId} onClick={() => setZoneId(z.id)}>
            <span className="zone-card-head">
              <strong>{z.nom}</strong> <span className="mono muted">{z.code}</span>
            </span>
            <span className="zone-rate">{pct(z.taux)}</span>
            <span className="meter" aria-hidden="true">
              <span style={{ width: `${Math.min(100, Math.round((z.taux ?? 0) * 100))}%` }} />
            </span>
            <small>
              {FILL[z.etat]} · {ZONE_TYPE[z.type] ?? z.type} · {z.nbEmplacements} empl. · {z.nbArticles} bien{z.nbArticles > 1 ? 's' : ''}
              {z.nbClients ? ` · ${z.nbClients} client${z.nbClients > 1 ? 's' : ''}` : ''}
            </small>
            {z.inventaire && <span className="zone-inv">Inventaire {z.inventaire.numero}</span>}
          </button>
        ))}
      </div>
      {zone && <ZoneDetail key={zone.id} zone={zone} onLaunched={() => void load()} />}
    </>
  );
}

function Legend() {
  return (
    <ul className="plan-legend" aria-label="Légende">
      {(Object.keys(FILL) as Fill[]).map((f) => (
        <li key={f}>
          <span className={`swatch fill-${f}`} aria-hidden="true" /> {FILL[f]}
          {f === 'PLEIN' ? ' (90 % et plus)' : ''}
        </li>
      ))}
    </ul>
  );
}

function ZoneDetail({ zone, onLaunched }: { zone: PlanZone; onLaunched: () => void }) {
  const [loc, setLoc] = useState<string | null>(null);
  const [c, setC] = useState<Contents | null>(null);
  const [launch, setLaunch] = useState(false);
  useEffect(() => {
    setC(null);
    void get<Contents>(`/bo/warehouse/zones/${zone.id}/contents${loc ? `?emplacement=${loc}` : ''}`).then(setC, () => setC(null));
  }, [zone.id, loc]);
  const current = zone.emplacements.find((l) => l.id === loc);

  return (
    <div className="bo-grid-2 plan-detail">
      <section className="panel">
        <div className="panel-head">
          <h2>
            {zone.nom} <span className="mono muted">{zone.code}</span>
          </h2>
          {zone.inventaire ? (
            <a className="btn small" href={href({ name: 'inventaire', id: zone.inventaire.id })}>
              Inventaire {zone.inventaire.numero}
            </a>
          ) : (
            zone.nbEmplacements > 0 && (
              <button type="button" className="btn small" onClick={() => setLaunch((x) => !x)}>
                Lancer un inventaire tournant
              </button>
            )
          )}
        </div>
        {launch && <LaunchForm zone={zone} onDone={onLaunched} />}
        <p className="muted">
          {zone.libres} libre{zone.libres > 1 ? 's' : ''} · {zone.partiels} partiel{zone.partiels > 1 ? 's' : ''} · {zone.pleins} plein{zone.pleins > 1 ? 's' : ''}
          {zone.indisponibles ? ` · ${zone.indisponibles} indisponible${zone.indisponibles > 1 ? 's' : ''}` : ''}
        </p>
        {zone.emplacements.length ? (
          <div className="loc-grid" role="list">
            {zone.emplacements.map((l) => (
              <button
                key={l.id}
                type="button"
                role="listitem"
                className={`loc fill-${l.etat}${l.id === loc ? ' selected' : ''}`}
                title={`${l.chemin} · ${FILL[l.etat]}${l.surfaceM2 ? ` · ${m2(l.occupeM2)} / ${m2(l.surfaceM2)}` : ''} · ${l.nbArticles} bien(s)`}
                aria-label={`${l.code} : ${FILL[l.etat]}, ${l.nbArticles} bien(s)`}
                aria-pressed={l.id === loc}
                onClick={() => setLoc(l.id === loc ? null : l.id)}
              >
                <span className="mono">{l.code.split('-').slice(2).join('-') || l.code}</span>
                <small>{l.surfaceM2 ? pct(l.occupeM2 / l.surfaceM2) : l.nbArticles || ''}</small>
              </button>
            ))}
          </div>
        ) : (
          <p className="hint">Aucun emplacement adressable dans cette zone.</p>
        )}
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>{current ? <span className="mono">{current.code}</span> : 'Clients présents'}</h2>
          {current && (
            <button type="button" className="link" onClick={() => setLoc(null)}>
              Toute la zone
            </button>
          )}
        </div>
        {current && <p className="muted">{current.chemin}</p>}
        {!c ? (
          <p className="hint">Chargement…</p>
        ) : !c.articles.length ? (
          <p className="empty">Aucun bien {current ? 'à cet emplacement' : 'dans cette zone'}.</p>
        ) : (
          <>
            <ul className="plain-list client-list">
              {c.clients.map((x) => (
                <li key={x.entrepriseId}>
                  <span>
                    <strong>{x.client}</strong>
                    {x.projets.length > 0 && <small className="muted"> · {x.projets.join(', ')}</small>}
                  </span>
                  <span className="mono">{x.nbArticles}</span>
                </li>
              ))}
            </ul>
            <div className="table-wrap flat">
              <table className="table">
                <thead>
                  <tr>
                    <th>Bien</th>
                    <th>Client</th>
                    <th>Emplacement</th>
                  </tr>
                </thead>
                <tbody>
                  {c.articles.slice(0, 200).map((a) => (
                    <tr key={a.id}>
                      <td>
                        <a href={href({ name: 'article', id: a.id })}>{a.libelle}</a>
                        <div className="muted mono small">
                          {a.qrCode}
                          {a.statut !== 'EN_STOCK' ? ` · ${ARTICLE_STATUS[a.statut] ?? a.statut}` : ''}
                        </div>
                      </td>
                      <td>
                        {a.client}
                        {a.projet && <div className="muted small">{a.projet}</div>}
                      </td>
                      <td className="mono">
                        {a.emplacementCode}
                        {a.umQr && <div className="muted small">{a.umQr}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {c.articles.length > 200 && <p className="hint">200 premiers biens sur {c.articles.length}.</p>}
          </>
        )}
      </section>
    </div>
  );
}

function LaunchForm({ zone, onDone }: { zone: PlanZone; onDone: () => void }) {
  const [ops, setOps] = useState<{ id: string; nom: string }[]>([]);
  const [assigneA, setAssigneA] = useState('');
  const [par, setPar] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
    void get<{ ressources: { id: string; nom: string; role: string }[] }>(`/bo/planning?date=${today}`).then(
      (p) => setOps(p.ressources.filter((r) => r.role === 'OPERATOR')),
      () => setOps([]),
    );
  }, []);
  const missions = Math.ceil(zone.nbEmplacements / par);
  return (
    <form
      className="inline-form launch-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const r = await post<{ id: string }>('/bo/inventaires', { zoneId: zone.id, parMission: par, ...(assigneA ? { assigneA } : {}) });
          onDone();
          window.location.hash = href({ name: 'inventaire', id: r.id });
        } catch (err) {
          setError((err as Error).message);
          setBusy(false);
        }
      }}
    >
      <p className="hint">
        L’opérateur scanne chaque emplacement puis tout ce qu’il y trouve, sans voir le stock attendu. Les écarts vous reviennent pour arbitrage ; rien n’est corrigé
        automatiquement.
      </p>
      <label>
        Emplacements par mission
        <input type="number" min={5} max={200} value={par} onChange={(e) => setPar(Math.max(5, Math.min(200, Number(e.target.value) || 30)))} />
      </label>
      <label>
        Opérateur
        <select value={assigneA} onChange={(e) => setAssigneA(e.target.value)}>
          <option value="">À affecter au planning</option>
          {ops.map((o) => (
            <option key={o.id} value={o.id}>
              {o.nom}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn primary" disabled={busy}>
        {busy ? '…' : `Lancer : ${missions} mission${missions > 1 ? 's' : ''} de comptage`}
      </button>
      {error && <Banner kind="error">{error}</Banner>}
    </form>
  );
}

// ------------------------------------------------------------------ inventaires tournants

type InvStatut = 'EN_COURS' | 'A_ARBITRER' | 'CLOS' | 'ANNULE';
const INV_STATUT: Record<InvStatut, string> = { EN_COURS: 'Comptage en cours', A_ARBITRER: 'Écarts à arbitrer', CLOS: 'Clos', ANNULE: 'Annulé' };
const invTone = (s: InvStatut) => (s === 'A_ARBITRER' ? 'lime' : s === 'EN_COURS' ? 'dark' : 'neutral');
interface InvRow {
  id: string;
  numero: string;
  statut: InvStatut;
  lanceLe: string;
  termineLe: string | null;
  closLe: string | null;
  nbEmplacements: number;
  depotId: string;
  depot: string;
  zoneId: string;
  zoneCode: string;
  zone: string;
  lancePar: string | null;
  comptes: number;
  ecarts: number;
  aArbitrer: number;
}

export function Inventories() {
  const [filter, setFilter] = useState<'OUVERTS' | 'CLOS' | ''>('OUVERTS');
  const [items, setItems] = useState<InvRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setItems(null);
    void get<{ items: InvRow[] }>(`/bo/inventaires${filter ? `?statut=${filter}` : ''}`).then(
      (r) => setItems(r.items),
      (e) => setError((e as Error).message),
    );
  }, [filter]);
  return (
    <>
      <section className="page-head">
        <span className="eyebrow">— Dépôts</span>
        <h1>Inventaires tournants</h1>
        <p className="lead">Comptage d’une zone emplacement par emplacement. Lancez-en un depuis le plan d’occupation d’un dépôt.</p>
      </section>
      <DepotTabs active="inventaires" />
      <Pills
        label="Filtre"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'OUVERTS', label: 'En cours et à arbitrer' },
          { value: 'CLOS', label: 'Clos' },
          { value: '', label: 'Tous' },
        ]}
      />
      {error && <Banner kind="error">{error}</Banner>}
      {!items ? (
        <p className="hint">Chargement…</p>
      ) : !items.length ? (
        <p className="empty">Aucun inventaire ici. Ouvrez le plan d’un dépôt et choisissez une zone pour en lancer un.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Inventaire</th>
                <th>Zone</th>
                <th>Avancement</th>
                <th>Écarts</th>
                <th>Statut</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => (window.location.hash = href({ name: 'inventaire', id: i.id }))}>
                  <td>
                    <a className="mono" href={href({ name: 'inventaire', id: i.id })}>
                      {i.numero}
                    </a>
                    <div className="muted small">
                      lancé le {dateFr(i.lanceLe)}
                      {i.lancePar ? ` par ${i.lancePar}` : ''}
                    </div>
                  </td>
                  <td>
                    {i.zone} <span className="mono muted">{i.zoneCode}</span>
                    <div className="muted small">{i.depot}</div>
                  </td>
                  <td>
                    {i.comptes} / {i.nbEmplacements} emplacements
                  </td>
                  <td>{i.ecarts ? `${i.ecarts}${i.aArbitrer ? `, dont ${i.aArbitrer} à arbitrer` : ''}` : 'Aucun'}</td>
                  <td>
                    <StatusPill label={INV_STATUT[i.statut]} tone={invTone(i.statut)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

interface Ecart {
  id: string;
  type: 'MANQUANT' | 'DEPLACE' | 'INCONNU';
  qr: string | null;
  decision: 'CORRIGE' | 'PERDU' | 'IGNORE' | null;
  motif: string | null;
  decideLe: string | null;
  decidePar: string | null;
  emplacementCode: string;
  emplacement: string;
  emplacementSystemeCode: string | null;
  articleId: string | null;
  articleQr: string | null;
  libelle: string | null;
  statutArticle: string | null;
  client: string | null;
  aBouge: boolean | null;
}
interface InvDetail extends Omit<InvRow, 'comptes' | 'ecarts' | 'aArbitrer'> {
  missions: { id: string; statut: string; debutPrevu: string; assigne: string | null; partie: number; nbEmplacements: number; comptes: number }[];
  ecarts: Ecart[];
  comptages: { code: string; chemin: string; compteLe: string | null; attendus: number; trouves: number; inconnus: number }[];
}
const ECART: Record<Ecart['type'], string> = { MANQUANT: 'Manquant', DEPLACE: 'Trouvé ailleurs', INCONNU: 'Étiquette inconnue' };
const DECISION: Record<NonNullable<Ecart['decision']>, string> = { CORRIGE: 'Emplacement corrigé', PERDU: 'Déclaré perdu', IGNORE: 'Ignoré' };
const MISSION_STATUT: Record<string, string> = { A_AFFECTER: 'À affecter', AFFECTEE: 'Affectée', EN_COURS: 'En cours', TERMINEE: 'Terminée', ANNULEE: 'Annulée' };

export function InventoryView({ id }: { id: string }) {
  const [d, setD] = useState<InvDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(() => get<InvDetail>(`/bo/inventaires/${id}`).then(setD, (e) => setError((e as Error).message)), [id]);
  useEffect(() => void load(), [load]);
  // pendant le comptage, les écarts arrivent au fil des terminaux
  const running = d?.statut === 'EN_COURS';
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [running, load]);
  if (!d) return error ? <Banner kind="error">{error}</Banner> : <p className="hint">Chargement…</p>;
  const comptes = d.comptages.filter((c) => c.compteLe).length;
  const open = d.ecarts.filter((x) => !x.decision);
  const done = d.ecarts.filter((x) => x.decision);

  return (
    <>
      <a className="back" href={href({ name: 'inventaires' })}>
        ← Inventaires tournants
      </a>
      <section className="page-head">
        <span className="eyebrow">
          — Inventaire · <span className="mono">{d.numero}</span>
        </span>
        <h1>
          {d.zone} <span className="mono muted">{d.zoneCode}</span>
        </h1>
        <p className="lead">
          {d.depot} · lancé le {dateFr(d.lanceLe)} à {timeFr(d.lanceLe)}
          {d.lancePar ? ` par ${d.lancePar}` : ''} · <StatusPill label={INV_STATUT[d.statut]} tone={invTone(d.statut)} />
        </p>
      </section>
      <div className="tiles">
        <Tile n={`${comptes} / ${d.nbEmplacements}`} label="emplacements comptés" accent={d.statut === 'EN_COURS'} />
        <Tile n={open.length} label="écarts à arbitrer" accent={!!open.length} />
        <Tile n={d.ecarts.filter((x) => x.type === 'MANQUANT').length} label="manquants" />
        <Tile n={d.ecarts.filter((x) => x.type === 'DEPLACE').length} label="trouvés ailleurs" />
      </div>
      {notice && <Banner kind="ok">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
      <div className="bo-grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Écarts {open.length ? 'à arbitrer' : ''}</h2>
          </div>
          {d.statut === 'EN_COURS' && <p className="hint">Les écarts s’affichent au fil du comptage ; vous pouvez commencer à les arbitrer.</p>}
          {!d.ecarts.length && d.statut !== 'EN_COURS' && <p className="empty">Aucun écart : le stock compté correspond au système.</p>}
          <ul className="ecart-list">
            {open.map((x) => (
              <EcartItem key={x.id} inv={d} x={x} onDone={(m) => (setNotice(m), setError(null), void load())} onError={setError} />
            ))}
          </ul>
          {done.length > 0 && (
            <details className="ecarts-done">
              <summary>
                {done.length} écart{done.length > 1 ? 's' : ''} arbitré{done.length > 1 ? 's' : ''}
              </summary>
              <ul className="ecart-list">
                {done.map((x) => (
                  <li key={x.id} className="ecart done">
                    <div className="ecart-head">
                      <strong>{ECART[x.type]}</strong> <span className="mono muted">{x.emplacementCode}</span>
                      <StatusPill label={DECISION[x.decision!]} />
                    </div>
                    <span>{x.libelle ?? x.qr}</span>
                    <small className="muted">
                      {x.motif} · {x.decidePar ?? ''} le {dateFr(x.decideLe)}
                    </small>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Missions de comptage</h2>
            {d.statut === 'EN_COURS' && <CancelButton id={d.id} onDone={() => (setNotice('Inventaire annulé, ses missions aussi.'), void load())} onError={setError} />}
          </div>
          <ul className="plain-list">
            {d.missions.map((m) => (
              <li key={m.id}>
                <span>
                  <strong>Partie {m.partie}</strong> · {m.comptes} / {m.nbEmplacements} emplacements
                  <small className="muted"> · {m.assigne ?? 'à affecter au planning'}</small>
                </span>
                <StatusPill label={MISSION_STATUT[m.statut] ?? m.statut} tone={m.statut === 'A_AFFECTER' ? 'lime' : 'neutral'} />
              </li>
            ))}
          </ul>
          <details className="comptages">
            <summary>Détail par emplacement</summary>
            <div className="table-wrap flat">
              <table className="table">
                <thead>
                  <tr>
                    <th>Emplacement</th>
                    <th>Attendus</th>
                    <th>Scannés</th>
                  </tr>
                </thead>
                <tbody>
                  {d.comptages.map((c) => (
                    <tr key={c.code}>
                      <td className="mono">{c.code}</td>
                      <td>{c.compteLe ? c.attendus : '—'}</td>
                      <td>{c.compteLe ? c.trouves + c.inconnus : 'à compter'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      </div>
    </>
  );
}

function EcartItem({ inv, x, onDone, onError }: { inv: InvDetail; x: Ecart; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [motif, setMotif] = useState('');
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'CORRIGE' | 'PERDU' | 'IGNORE') => {
    setBusy(true);
    try {
      await post(`/bo/inventaires/${inv.id}/ecarts/${x.id}`, { decision, motif: motif.trim() });
      onDone(`${x.libelle ?? x.qr} : ${DECISION[decision].toLowerCase()}.`);
    } catch (e) {
      onError((e as Error).message);
      setBusy(false);
    }
  };
  const ready = motif.trim().length >= 3 && !busy;
  return (
    <li className={`ecart t-${x.type}`}>
      <div className="ecart-head">
        <strong>{ECART[x.type]}</strong> <span className="mono muted">{x.emplacementCode}</span>
      </div>
      {x.articleId ? (
        <span>
          <a href={href({ name: 'article', id: x.articleId })}>{x.libelle}</a> <span className="mono muted small">{x.articleQr}</span>
          {x.client && <small className="muted"> · {x.client}</small>}
        </span>
      ) : (
        <span className="mono">{x.qr}</span>
      )}
      <small className="muted">
        {x.type === 'MANQUANT'
          ? `Attendu en ${x.emplacementCode}, non scanné au comptage.`
          : x.type === 'DEPLACE'
            ? `Scanné en ${x.emplacementCode}, alors que le système le plaçait ${x.emplacementSystemeCode ? `en ${x.emplacementSystemeCode}` : `hors rayon (${(ARTICLE_STATUS[x.statutArticle ?? ''] ?? x.statutArticle ?? '').toLowerCase()})`}.`
            : 'Étiquette scannée qui ne correspond à aucun bien.'}
        {x.aBouge && x.type !== 'INCONNU' ? ' Le bien a bougé depuis le comptage.' : ''}
      </small>
      <input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Motif (obligatoire, visible dans l’audit)" aria-label={`Motif pour ${x.libelle ?? x.qr}`} maxLength={500} />
      <div className="row-actions">
        {x.type === 'DEPLACE' && (
          <button type="button" className="btn primary small" disabled={!ready} onClick={() => void decide('CORRIGE')}>
            Corriger : le placer en {x.emplacementCode}
          </button>
        )}
        {x.type === 'MANQUANT' && (
          <button type="button" className="btn danger small" disabled={!ready} onClick={() => void decide('PERDU')}>
            Déclarer perdu
          </button>
        )}
        <button type="button" className="btn small" disabled={!ready} onClick={() => void decide('IGNORE')}>
          Ignorer
        </button>
      </div>
    </li>
  );
}

function CancelButton({ id, onDone, onError }: { id: string; onDone: () => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [motif, setMotif] = useState('');
  if (!open)
    return (
      <button type="button" className="link" onClick={() => setOpen(true)}>
        Annuler l’inventaire
      </button>
    );
  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await post(`/bo/inventaires/${id}/annuler`, { motif: motif.trim() });
          onDone();
        } catch (err) {
          onError((err as Error).message);
        }
      }}
    >
      <input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Motif de l’annulation" aria-label="Motif de l’annulation" />
      <button type="submit" className="btn danger small" disabled={motif.trim().length < 3}>
        Confirmer
      </button>
    </form>
  );
}
