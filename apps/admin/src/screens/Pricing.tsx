import { useCallback, useEffect, useState } from 'react';
import { get, post, put } from '../lib/api';
import { go } from '../lib/router';
import type { BoContext } from '../lib/types';
import { addDays, dateFr, euros, m2, parseEuros } from '../lib/labels';
import { Banner, StatusPill } from '../components/ui';
import { BillingTabs, SurfaceChart } from './Billing';

/** FAC-01 : grilles tarifaires versionnées et forfaits clients (avenants), et FAC-02 : surfaces quotidiennes. */

interface GrilleLigne {
  code: string;
  libelle: string;
  unite: string;
  prix_ht_cents: number;
  tva: number;
}
interface Grille {
  id: string;
  nom: string;
  type: 'STANDARD_B2C' | 'SUR_MESURE_B2B';
  version: number;
  valideDu: string;
  valideAu: string | null;
  prixM2MoisCents: number | null;
  m2Minimum: number;
  lignes: GrilleLigne[];
  utilisee: boolean;
  nbForfaits: number;
}
interface Forfait {
  id: string;
  clientId: string;
  client: string;
  typeClient: 'B2B' | 'B2C';
  version: number;
  statut: string;
  grilleId: string;
  grille: string;
  grilleVersion: number;
  m2Inclus: number;
  prixMensuelCents: number;
  prixM2DepassementCents: number;
  prestationsIncluses: Record<string, number>;
  modeSurface: 'MOYENNE' | 'PIC';
  dateDebut: string;
  dateFin: string | null;
  engagementMois: number | null;
}

const GRILLE_TYPE = { STANDARD_B2C: 'Standard particuliers', SUR_MESURE_B2B: 'Sur-mesure entreprises' };
const cents = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2).replace('.', ','));

export function Pricing({ ctx }: { ctx: BoContext }) {
  const [grilles, setGrilles] = useState<Grille[] | null>(null);
  const [forfaits, setForfaits] = useState<Forfait[] | null>(null);
  const [editing, setEditing] = useState<Grille | null>(null);
  const [avenant, setAvenant] = useState<Forfait | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    get<{ items: Grille[] }>('/bo/billing/grilles').then((r) => setGrilles(r.items)).catch((e) => setError((e as Error).message));
    get<{ items: Forfait[] }>('/bo/billing/forfaits').then((r) => setForfaits(r.items)).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  const done = (msg: string) => {
    setNotice(msg);
    setError(null);
    setEditing(null);
    setAvenant(null);
    load();
  };

  const today = ctx.today;
  const current = (forfaits ?? []).filter((f) => f.statut === 'ACTIF' && (!f.dateFin || f.dateFin >= today));
  const past = (forfaits ?? []).filter((f) => !current.includes(f));

  return (
    <>
      <section className="bo-head">
        <div>
          <p className="eyebrow">— Facturation</p>
          <h1>Grilles et forfaits</h1>
          <p className="lead">Un tarif modifié ne s’applique qu’aux périodes suivantes : on crée une nouvelle version de grille, ou un avenant au forfait du client.</p>
        </div>
      </section>
      <BillingTabs active="tarifs" />
      {notice && <Banner kind="ok">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}

      <section className="panel">
        <div className="panel-head">
          <h2>Forfaits en cours</h2>
          <button type="button" className="btn small" onClick={() => setAvenant('new')}>
            Nouveau forfait ou avenant
          </button>
        </div>
        {avenant && grilles && (
          <ForfaitForm ctx={ctx} base={avenant === 'new' ? null : avenant} grilles={grilles} onDone={done} onCancel={() => setAvenant(null)} onError={setError} />
        )}
        {!forfaits ? (
          <p className="hint">Chargement…</p>
        ) : (
          <div className="table-wrap flat">
            <table className="table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th className="num">Inclus</th>
                  <th className="num">Prix mensuel HT</th>
                  <th className="num">Dépassement HT</th>
                  <th>Prestations incluses</th>
                  <th>Période</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {current.map((f) => (
                  <ForfaitRow key={f.id} f={f} today={today} onAvenant={f.dateFin ? undefined : () => setAvenant(f)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {past.length > 0 && (
          <details className="more">
            <summary>Forfaits terminés ou à venir ({past.length})</summary>
            <table className="table compact">
              <tbody>
                {past.map((f) => (
                  <ForfaitRow key={f.id} f={f} today={today} />
                ))}
              </tbody>
            </table>
          </details>
        )}
      </section>

      <section className="panel stacked">
        <h2>Grilles tarifaires</h2>
        {editing && <GrilleForm base={editing} onDone={done} onCancel={() => setEditing(null)} onError={setError} />}
        <div className="grilles">
          {(grilles ?? []).map((g) => (
            <article key={g.id} className={`grille${g.valideAu && g.valideAu < today ? ' old' : ''}`}>
              <header>
                <div>
                  <strong>{g.nom}</strong> <span className="muted">v{g.version}</span>
                  <div className="muted">
                    {GRILLE_TYPE[g.type]} · depuis le {dateFr(g.valideDu)}
                    {g.valideAu ? ` jusqu’au ${dateFr(g.valideAu)}` : ''}
                  </div>
                </div>
                <StatusPill label={g.utilisee ? 'Utilisée' : 'Modifiable'} tone={g.utilisee ? 'dark' : 'accent'} />
              </header>
              <dl className="facts">
                <dt>Prix au m²</dt>
                <dd>{g.prixM2MoisCents != null ? `${euros(g.prixM2MoisCents)} HT / mois` : '—'}</dd>
                <dt>Minimum</dt>
                <dd>{g.m2Minimum ? m2(g.m2Minimum) : 'aucun'}</dd>
              </dl>
              <table className="table compact">
                <tbody>
                  {g.lignes.map((l) => (
                    <tr key={l.code}>
                      <td>
                        {l.libelle}
                        <div className="muted mono">{l.code}</div>
                      </td>
                      <td className="num">
                        {euros(l.prix_ht_cents)} / {l.unite}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!g.valideAu && (
                <button type="button" className="btn small" onClick={() => setEditing(g)}>
                  {g.utilisee ? 'Nouvelle version' : 'Modifier'}
                </button>
              )}
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

function ForfaitRow({ f, today, onAvenant }: { f: Forfait; today: string; onAvenant?: () => void }) {
  const incl = Object.entries(f.prestationsIncluses ?? {}).filter(([, n]) => n > 0);
  return (
    <tr>
      <td>
        <strong>{f.client}</strong> {f.dateDebut > today && <StatusPill label="À venir" tone="accent" />}
        <div className="muted">
          v{f.version} · grille {f.grille} v{f.grilleVersion}
          {f.modeSurface === 'PIC' ? ' · pic du mois' : ''}
        </div>
      </td>
      <td className="num">{m2(f.m2Inclus)}</td>
      <td className="num">{euros(f.prixMensuelCents)}</td>
      <td className="num">{euros(f.prixM2DepassementCents)} / m²</td>
      <td>{incl.length ? incl.map(([k, n]) => `${n} ${k.toLowerCase()}${n > 1 ? 's' : ''} / mois`).join(', ') : '—'}</td>
      <td>
        depuis le {dateFr(f.dateDebut)}
        {f.dateFin ? ` jusqu’au ${dateFr(f.dateFin)}` : ''}
        {f.engagementMois ? <div className="muted">engagement {f.engagementMois} mois</div> : null}
      </td>
      <td className="num">
        {onAvenant && (
          <button type="button" className="btn small ghost-dark" onClick={onAvenant}>
            Avenant
          </button>
        )}
      </td>
    </tr>
  );
}

function ForfaitForm({
  ctx,
  base,
  grilles,
  onDone,
  onCancel,
  onError,
}: {
  ctx: BoContext;
  base: Forfait | null;
  grilles: Grille[];
  onDone: (m: string) => void;
  onCancel: () => void;
  onError: (e: string) => void;
}) {
  const live = grilles.filter((g) => !g.valideAu || g.valideAu >= ctx.today);
  const firstOfNext = (() => {
    const d = new Date(`${ctx.today.slice(0, 7)}-01T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString().slice(0, 10);
  })();
  const [client, setClient] = useState(base?.clientId ?? '');
  const [grille, setGrille] = useState(base ? (live.find((g) => g.nom === base.grille)?.id ?? base.grilleId) : (live[0]?.id ?? ''));
  const [inclus, setInclus] = useState(String(base?.m2Inclus ?? ''));
  const [prix, setPrix] = useState(cents(base?.prixMensuelCents));
  const [dep, setDep] = useState(cents(base?.prixM2DepassementCents));
  const [livraisons, setLivraisons] = useState(String(base?.prestationsIncluses?.LIVRAISON ?? 0));
  const [mode, setMode] = useState<'MOYENNE' | 'PIC'>(base?.modeSurface ?? 'MOYENNE');
  const [debut, setDebut] = useState(firstOfNext);
  const [engagement, setEngagement] = useState(String(base?.engagementMois ?? ''));
  const [motif, setMotif] = useState('');
  const [busy, setBusy] = useState(false);
  const p = parseEuros(prix);
  const d = parseEuros(dep);
  const m = Number(inclus.replace(',', '.'));
  return (
    <form
      className="stack form-card"
      onSubmit={async (e) => {
        e.preventDefault();
        if (p == null || d == null || !(m > 0)) return;
        setBusy(true);
        try {
          await post('/bo/billing/forfaits', {
            entrepriseId: client,
            grilleId: grille,
            m2Inclus: m,
            prixMensuelCents: p,
            prixM2DepassementCents: d,
            prestationsIncluses: Number(livraisons) > 0 ? { LIVRAISON: Number(livraisons) } : {},
            modeSurface: mode,
            dateDebut: debut,
            ...(engagement ? { engagementMois: Number(engagement) } : {}),
            ...(motif ? { motif } : {}),
          });
          onDone(`Forfait enregistré à partir du ${dateFr(debut)}${base ? ` ; l’ancien s’arrête le ${dateFr(addDays(debut, -1))}` : ''}.`);
        } catch (err) {
          onError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>{base ? `Avenant au forfait de ${base.client}` : 'Nouveau forfait'}</h3>
      <div className="row">
        <label>
          Client
          <select value={client} onChange={(e) => setClient(e.target.value)} required disabled={!!base}>
            <option value="">Choisir…</option>
            {ctx.clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nom}
              </option>
            ))}
          </select>
        </label>
        <label>
          Grille tarifaire
          <select value={grille} onChange={(e) => setGrille(e.target.value)} required>
            {live.map((g) => (
              <option key={g.id} value={g.id}>
                {g.nom} v{g.version}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <label>
          m² inclus
          <input inputMode="decimal" value={inclus} onChange={(e) => setInclus(e.target.value)} required />
        </label>
        <label>
          Prix mensuel HT (€)
          <input inputMode="decimal" value={prix} onChange={(e) => setPrix(e.target.value)} required />
        </label>
        <label>
          Dépassement HT (€ / m²)
          <input inputMode="decimal" value={dep} onChange={(e) => setDep(e.target.value)} required />
        </label>
      </div>
      <div className="row">
        <label>
          Livraisons incluses / mois
          <input type="number" min={0} max={100} value={livraisons} onChange={(e) => setLivraisons(e.target.value)} />
        </label>
        <label>
          Surface facturée
          <select value={mode} onChange={(e) => setMode(e.target.value as 'MOYENNE' | 'PIC')}>
            <option value="MOYENNE">Moyenne des jours (recommandé)</option>
            <option value="PIC">Pic du mois</option>
          </select>
        </label>
        <label>
          Engagement (mois)
          <input type="number" min={0} max={120} value={engagement} onChange={(e) => setEngagement(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <label>
          À partir du
          <input type="date" value={debut} min={ctx.today.slice(0, 8) + '01'} onChange={(e) => setDebut(e.target.value)} required />
        </label>
        <label>
          Motif {base ? '(avenant)' : '(facultatif)'}
          <input value={motif} onChange={(e) => setMotif(e.target.value)} maxLength={500} required={!!base} minLength={base ? 3 : undefined} placeholder="Extension du programme" />
        </label>
      </div>
      <div className="row-actions">
        <button className="btn primary" disabled={busy || !client || p == null || d == null || !(m > 0)}>
          Enregistrer
        </button>
        <button type="button" className="btn ghost-dark" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}

function GrilleForm({ base, onDone, onCancel, onError }: { base: Grille; onDone: (m: string) => void; onCancel: () => void; onError: (e: string) => void }) {
  const versioning = base.utilisee;
  const nextMonth = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1, 1);
    return d.toISOString().slice(0, 10);
  })();
  const [valideDu, setValideDu] = useState(versioning ? nextMonth : base.valideDu);
  const [prixM2, setPrixM2] = useState(cents(base.prixM2MoisCents));
  const [min, setMin] = useState(String(base.m2Minimum));
  const [lignes, setLignes] = useState(base.lignes.map((l) => ({ ...l, prix: cents(l.prix_ht_cents) })));
  const [busy, setBusy] = useState(false);
  const pm2 = parseEuros(prixM2);
  const parsed = lignes.map((l) => ({ code: l.code, libelle: l.libelle, unite: l.unite, tva: l.tva, prix_ht_cents: parseEuros(l.prix) }));
  const valid = pm2 != null && parsed.every((l) => l.prix_ht_cents != null);
  return (
    <form
      className="stack form-card"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        setBusy(true);
        const body = { nom: base.nom, type: base.type, valideDu, prixM2MoisCents: pm2, m2Minimum: Number(min.replace(',', '.')) || 0, lignes: parsed };
        try {
          if (versioning) await post('/bo/billing/grilles', { ...body, baseId: base.id });
          else await put(`/bo/billing/grilles/${base.id}`, body);
          onDone(versioning ? `Version ${base.version + 1} de « ${base.nom} » valable à partir du ${dateFr(valideDu)}.` : `Grille « ${base.nom} » mise à jour.`);
        } catch (err) {
          onError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>{versioning ? `Nouvelle version de « ${base.nom} »` : `Modifier « ${base.nom} »`}</h3>
      {versioning && <p className="muted">Cette grille a déjà servi à facturer : la version {base.version} reste en vigueur jusqu’à la veille de la nouvelle.</p>}
      <div className="row">
        <label>
          Valable à partir du
          <input type="date" value={valideDu} onChange={(e) => setValideDu(e.target.value)} required />
        </label>
        <label>
          Prix au m² HT / mois (€)
          <input inputMode="decimal" value={prixM2} onChange={(e) => setPrixM2(e.target.value)} required />
        </label>
        <label>
          Minimum facturé (m²)
          <input inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} />
        </label>
      </div>
      <table className="table compact">
        <thead>
          <tr>
            <th>Prestation</th>
            <th>Unité</th>
            <th className="num">Prix HT (€)</th>
          </tr>
        </thead>
        <tbody>
          {lignes.map((l, i) => (
            <tr key={l.code}>
              <td>
                {l.libelle}
                <div className="muted mono">{l.code}</div>
              </td>
              <td>{l.unite}</td>
              <td className="num">
                <input
                  className="price"
                  inputMode="decimal"
                  aria-label={`Prix de ${l.libelle}`}
                  value={l.prix}
                  onChange={(e) => setLignes(lignes.map((x, j) => (j === i ? { ...x, prix: e.target.value } : x)))}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row-actions">
        <button className="btn primary" disabled={busy || !valid}>
          {versioning ? 'Créer la version' : 'Enregistrer'}
        </button>
        <button type="button" className="btn ghost-dark" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------------------------------------------------

interface Occupation {
  du: string;
  au: string;
  m2Inclus: number | null;
  jours: { date: string; m2: number; nbArticles: number; source: string; motif: string | null }[];
}

/** FAC-02 : surfaces relevées chaque jour pour un client, et correction motivée d'une période non facturée. */
export function Surfaces({ ctx, client }: { ctx: BoContext; client?: string }) {
  const id = client ?? ctx.clients[0]?.id ?? '';
  const [data, setData] = useState<Occupation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [du, setDu] = useState('');
  const [au, setAu] = useState('');
  const [val, setVal] = useState('');
  const [motif, setMotif] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    get<Occupation>(`/bo/billing/occupation?client=${id}`)
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => setError((e as Error).message));
  }, [id]);
  useEffect(load, [load]);
  const v = Number(val.replace(',', '.'));
  const yesterday = addDays(ctx.today, -1);

  return (
    <>
      <section className="bo-head">
        <div>
          <p className="eyebrow">— Facturation</p>
          <h1>Surfaces quotidiennes</h1>
          <p className="lead">Chaque soir à 23 h 59, la surface de chaque client est relevée. La facture du mois en fait la moyenne (ou retient le pic, selon le contrat).</p>
        </div>
        <select className="head-select" aria-label="Client" value={id} onChange={(e) => go({ name: 'surfaces', client: e.target.value })}>
          {ctx.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nom}
            </option>
          ))}
        </select>
      </section>
      <BillingTabs active="surfaces" />
      {notice && <Banner kind="ok">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
      <div className="two-col">
        <div className="col-main">
          <section className="panel">
            <h2>Relevés des 60 derniers jours</h2>
            {!data ? (
              <p className="hint">Chargement…</p>
            ) : data.jours.length === 0 ? (
              <p className="empty">Aucun relevé sur la période.</p>
            ) : (
              <SurfaceChart days={data.jours} included={data.m2Inclus} />
            )}
          </section>
        </div>
        <aside className="col-side">
          <section className="panel">
            <h2>Corriger une période</h2>
            <p className="muted">Pour un oubli ou une erreur de saisie au dépôt. Impossible sur une période déjà facturée : émettez d’abord un avoir.</p>
            <form
              className="stack"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const r = await post<{ jours: number }>('/bo/billing/occupation/correct', { entrepriseId: id, du, au, m2: v, motif });
                  setNotice(`${r.jours} jour(s) corrigé(s). Recalculez le brouillon du mois concerné s’il existe.`);
                  setMotif('');
                  load();
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <div className="row">
                <label>
                  Du
                  <input type="date" value={du} max={yesterday} onChange={(e) => setDu(e.target.value)} required />
                </label>
                <label>
                  Au
                  <input type="date" value={au} max={yesterday} min={du} onChange={(e) => setAu(e.target.value)} required />
                </label>
              </div>
              <label>
                Surface réelle (m²)
                <input inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} required />
              </label>
              <label>
                Motif (journal d’audit)
                <input value={motif} onChange={(e) => setMotif(e.target.value)} required minLength={3} maxLength={500} placeholder="Box privatif oublié dans le calcul" />
              </label>
              <button className="btn" disabled={busy || !(v >= 0) || !val}>
                Corriger
              </button>
            </form>
          </section>
        </aside>
      </div>
    </>
  );
}
