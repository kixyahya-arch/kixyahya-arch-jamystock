import { useCallback, useEffect, useMemo, useState } from 'react';
import { AVERY_FORMATS, expandLocationPattern, ZEBRA_FORMATS } from '@jamystock/domain/browser';
import { api, apiBlob, del, get, post, put } from '../lib/api';
import { go, href } from '../lib/router';
import { m2 } from '../lib/labels';
import { Banner, Pills, StatusPill, Tile } from '../components/ui';

/** WMS-01 à 03 : dépôts, zones et emplacements, assistant de génération, import CSV et étiquettes QR. */

interface DepotSummary {
  id: string;
  nom: string;
  code: string;
  adresse: string | null;
  surfaceTotaleM2: number | null;
  zones: number;
  emplacements: number;
  indisponibles: number;
  surfaceEmplacementsM2: number;
  articles: number;
}
interface Zone {
  id: string;
  code: string;
  nom: string;
  type: string;
}
export interface Loc {
  id: string;
  zoneId: string;
  parentId: string | null;
  code: string;
  chemin: string;
  type: string;
  statut: string;
  adressable: boolean;
  longueurM: number | null;
  largeurM: number | null;
  hauteurM: number | null;
  surfaceM2: number;
  chargeMaxKg: number | null;
  niveaux: number;
  qrCode: string;
  articles: number;
  um: number;
}
interface Depot {
  id: string;
  nom: string;
  code: string;
  adresse: string | null;
  surfaceTotaleM2: number | null;
  zones: Zone[];
  emplacements: Loc[];
}

export const LOC_TYPE: Record<string, string> = { RACK: 'Rack', ETAGERE: 'Étagère', SOL: 'Sol' };
export const LOC_STATUS: Record<string, string> = { ACTIF: 'Actif', BLOQUE: 'Bloqué', MAINTENANCE: 'En maintenance' };
const ZONE_TYPE: Record<string, string> = { STOCKAGE: 'Stockage', RECEPTION: 'Réception', EXPEDITION: 'Expédition', QUARANTAINE: 'Quarantaine' };
const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`;

export function DepotTabs({ active }: { active: 'depots' | 'stock' }) {
  return (
    <nav className="subnav" aria-label="Dépôt">
      <a href={href({ name: 'depots' })} aria-current={active === 'depots' ? 'page' : undefined}>
        Dépôts et emplacements
      </a>
      <a href={href({ name: 'stock' })} aria-current={active === 'stock' ? 'page' : undefined}>
        Stock et corrections
      </a>
    </nav>
  );
}

// ------------------------------------------------------------------ liste des dépôts

export function Depots() {
  const [items, setItems] = useState<DepotSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    get<{ items: DepotSummary[] }>('/bo/warehouse/depots')
      .then((r) => setItems(r.items))
      .catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  return (
    <>
      <section className="bo-head">
        <div>
          <p className="eyebrow">— Dépôt</p>
          <h1>Dépôts</h1>
          <p className="lead">Chaque dépôt se découpe en zones, allées et emplacements. Le code d’un emplacement est celui imprimé sur son étiquette.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => setCreating((c) => !c)}>
          {creating ? 'Fermer' : 'Nouveau dépôt'}
        </button>
      </section>
      <DepotTabs active="depots" />
      {error && <Banner kind="error">{error}</Banner>}
      {creating && (
        <DepotForm
          onDone={(id) => go({ name: 'depot', id })}
          onError={setError}
        />
      )}
      {!items ? (
        !error && <p className="hint">Chargement…</p>
      ) : (
        <div className="depot-cards">
          {items.map((d) => (
            <a key={d.id} className="depot-card" href={href({ name: 'depot', id: d.id })}>
              <span className="depot-code" aria-hidden="true">
                {d.code}
              </span>
              <strong>{d.nom}</strong>
              <span className="muted">{d.adresse ?? 'Adresse à compléter'}</span>
              <dl className="mini-facts">
                <div>
                  <dt>Zones</dt>
                  <dd>{d.zones}</dd>
                </div>
                <div>
                  <dt>Emplacements</dt>
                  <dd>{d.emplacements.toLocaleString('fr-FR')}</dd>
                </div>
                <div>
                  <dt>Surface rangeable</dt>
                  <dd>{m2(d.surfaceEmplacementsM2)}</dd>
                </div>
                <div>
                  <dt>Articles</dt>
                  <dd>{d.articles.toLocaleString('fr-FR')}</dd>
                </div>
              </dl>
              {d.indisponibles > 0 && <StatusPill label={`${plural(d.indisponibles, 'emplacement')} indisponible${d.indisponibles > 1 ? 's' : ''}`} tone="alert" />}
            </a>
          ))}
        </div>
      )}
    </>
  );
}

function DepotForm({ base, onDone, onError }: { base?: Depot; onDone: (id: string) => void; onError: (m: string) => void }) {
  const [nom, setNom] = useState(base?.nom ?? '');
  const [code, setCode] = useState(base?.code ?? '');
  const [adresse, setAdresse] = useState(base?.adresse ?? '');
  const [surface, setSurface] = useState(base?.surfaceTotaleM2 != null ? String(base.surfaceTotaleM2) : '');
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack form-card"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const body = { nom, ...(adresse ? { adresse } : {}), surfaceTotaleM2: num(surface) };
          if (base) {
            await put(`/bo/warehouse/depots/${base.id}`, body);
            onDone(base.id);
          } else onDone((await post<{ id: string }>('/bo/warehouse/depots', { ...body, code })).id);
        } catch (err) {
          onError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>{base ? 'Modifier le dépôt' : 'Nouveau dépôt'}</h3>
      <div className="row">
        <label>
          Nom
          <input value={nom} onChange={(e) => setNom(e.target.value)} required minLength={2} placeholder="Dépôt Sud" />
        </label>
        {!base && (
          <label>
            Code (préfixe des emplacements)
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required maxLength={6} placeholder="S" />
          </label>
        )}
      </div>
      <div className="row">
        <label>
          Adresse
          <input value={adresse} onChange={(e) => setAdresse(e.target.value)} placeholder="4 rue du Port, 94200 Ivry-sur-Seine" />
        </label>
        <label>
          Surface totale (m²)
          <input inputMode="decimal" value={surface} onChange={(e) => setSurface(e.target.value)} />
        </label>
      </div>
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? 'Enregistrement…' : base ? 'Enregistrer' : 'Créer le dépôt'}
        </button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ un dépôt

type Panel = 'emplacement' | 'generer' | 'importer' | 'etiquettes' | 'zone';

export function DepotView({ id }: { id: string }) {
  const [depot, setDepot] = useState<Depot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>('generer');
  const [current, setCurrent] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(false);
  const [zoneId, setZoneId] = useState('');

  const load = useCallback(
    () =>
      get<Depot>(`/bo/warehouse/depots/${id}`)
        .then((d) => {
          setDepot(d);
          setZoneId((z) => z || d.zones.find((x) => x.type === 'STOCKAGE')?.id || d.zones[0]?.id || '');
        })
        .catch((e) => setError((e as Error).message)),
    [id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const done = (msg: string) => {
    setNotice(msg);
    setError(null);
    void load();
  };
  const fail = (msg: string) => {
    setError(msg);
    setNotice(null);
  };

  const byZone = useMemo(() => {
    const m = new Map<string, Loc[]>();
    for (const l of depot?.emplacements ?? []) m.set(l.zoneId, [...(m.get(l.zoneId) ?? []), l]);
    return m;
  }, [depot]);
  const needle = q.trim().toUpperCase();
  const match = (l: Loc) => !needle || l.code.includes(needle) || l.chemin.toUpperCase().includes(needle);
  const loc = depot?.emplacements.find((l) => l.id === current) ?? null;

  if (!depot) return error ? <Banner kind="error">{error}</Banner> : <p className="hint">Chargement…</p>;
  const addressable = depot.emplacements.filter((l) => l.adressable);
  const occupied = addressable.filter((l) => l.articles + l.um > 0).length;
  const unavailable = addressable.filter((l) => l.statut !== 'ACTIF').length;

  const toggle = (ids: string[], on?: boolean) => {
    const next = new Set(selected);
    const all = on ?? !ids.every((x) => next.has(x));
    for (const x of ids) {
      if (all) next.add(x);
      else next.delete(x);
    }
    setSelected(next);
  };
  const pick = (l: Loc) => {
    setCurrent(l.id);
    setPanel('emplacement');
  };

  return (
    <>
      <a className="back" href={href({ name: 'depots' })}>
        ← Dépôts
      </a>
      <section className="bo-head">
        <div>
          <p className="eyebrow">
            — Dépôt · <span className="mono">{depot.code}</span>
          </p>
          <h1>{depot.nom}</h1>
          <p className="lead">{depot.adresse ?? 'Adresse à compléter'}</p>
        </div>
        <button type="button" className="btn" onClick={() => setEditing((x) => !x)}>
          {editing ? 'Fermer' : 'Modifier'}
        </button>
      </section>
      {editing && (
        <DepotForm
          base={depot}
          onDone={() => {
            setEditing(false);
            done('Dépôt mis à jour ; les chemins des emplacements suivent le nouveau nom.');
          }}
          onError={fail}
        />
      )}
      <div className="tiles">
        <Tile n={depot.zones.length} label={depot.zones.length > 1 ? 'zones' : 'zone'} />
        <Tile n={addressable.length.toLocaleString('fr-FR')} label={addressable.length > 1 ? 'emplacements' : 'emplacement'} />
        <Tile n={occupied.toLocaleString('fr-FR')} label={occupied > 1 ? 'occupés' : 'occupé'} />
        <Tile n={unavailable} label={unavailable > 1 ? 'bloqués ou en maintenance' : 'bloqué ou en maintenance'} alert={unavailable > 0} />
        <Tile n={m2(addressable.reduce((s, l) => s + l.surfaceM2, 0))} label="surface rangeable" />
      </div>
      {notice && <Banner kind="ok">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}

      <div className="two-col">
        <div className="col-main">
          <section className="panel">
            <div className="panel-head">
              <h2>Arborescence</h2>
              <input className="search small" type="search" placeholder="Code ou chemin…" aria-label="Rechercher un emplacement" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <p className="legend muted">
              <span className="chip-key free" /> libre <span className="chip-key busy" /> occupé <span className="chip-key off" /> bloqué ou en maintenance · cliquez pour modifier, cochez pour imprimer
            </p>
            {depot.zones.length === 0 && <p className="empty">Aucune zone : créez-en une dans le panneau « Zone ».</p>}
            {depot.zones.map((z) => {
              const all = byZone.get(z.id) ?? [];
              const groups = all.filter((l) => !l.adressable);
              const loose = all.filter((l) => l.adressable && !l.parentId && match(l));
              const isOpen = open.has(z.id) || !!needle;
              const zoneAddr = all.filter((l) => l.adressable);
              return (
                <div key={z.id} className="tree-zone">
                  <div className="tree-head">
                    <button
                      type="button"
                      className="tree-toggle"
                      aria-expanded={isOpen}
                      onClick={() => {
                        const n = new Set(open);
                        if (n.has(z.id)) n.delete(z.id);
                        else n.add(z.id);
                        setOpen(n);
                      }}
                    >
                      <span className="caret" aria-hidden="true">
                        {isOpen ? '▾' : '▸'}
                      </span>
                      <strong>
                        {z.nom} <span className="mono muted">{z.code}</span>
                      </strong>
                      <span className="muted">
                        {ZONE_TYPE[z.type]} · {plural(zoneAddr.length, 'emplacement')}
                      </span>
                    </button>
                    {zoneAddr.length > 0 && (
                      <label className="inline check small">
                        <input type="checkbox" checked={zoneAddr.every((l) => selected.has(l.id))} onChange={(e) => toggle(zoneAddr.map((l) => l.id), e.target.checked)} /> tout
                      </label>
                    )}
                  </div>
                  {isOpen && (
                    <div className="tree-body">
                      {groups.map((g) => {
                        const kids = all.filter((l) => l.parentId === g.id && match(l));
                        if (needle && !kids.length && !match(g)) return null;
                        return (
                          <div key={g.id} className="tree-group">
                            <div className="tree-head sub">
                              <button type="button" className="link-like" onClick={() => pick(g)}>
                                {g.chemin.split(' > ').at(-1)} <span className="mono muted">{g.code}</span>
                              </button>
                              <span className="muted">
                                {LOC_TYPE[g.type]} · {plural(kids.length, 'emplacement')}
                              </span>
                              {kids.length > 0 && (
                                <label className="inline check small">
                                  <input type="checkbox" checked={kids.every((l) => selected.has(l.id))} onChange={(e) => toggle(kids.map((l) => l.id), e.target.checked)} /> tout
                                </label>
                              )}
                            </div>
                            <Chips locs={kids} selected={selected} current={current} onPick={pick} onToggle={(l) => toggle([l.id])} />
                          </div>
                        );
                      })}
                      {loose.length > 0 && <Chips locs={loose} selected={selected} current={current} onPick={pick} onToggle={(l) => toggle([l.id])} />}
                      {!all.length && <p className="hint">Zone vide : générez ou importez ses emplacements.</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        </div>
        <aside className="col-side">
          <section className="panel sticky-panel">
            <Pills<Panel>
              label="Actions"
              value={panel}
              onChange={setPanel}
              options={[
                { value: 'generer', label: 'Générer' },
                { value: 'importer', label: 'Importer' },
                { value: 'etiquettes', label: `Étiquettes${selected.size ? ` (${selected.size})` : ''}` },
                { value: 'emplacement', label: 'Emplacement' },
                { value: 'zone', label: 'Zone' },
              ]}
            />
            {panel === 'generer' && <Generator depot={depot} zoneId={zoneId} setZoneId={setZoneId} onDone={done} onError={fail} />}
            {panel === 'importer' && <CsvImport depot={depot} onDone={done} onError={fail} />}
            {panel === 'etiquettes' && <LabelsPanel ids={[...selected]} onClear={() => setSelected(new Set())} onError={fail} />}
            {panel === 'emplacement' &&
              (loc ? (
                <LocationEditor key={loc.id} loc={loc} onDone={done} onError={fail} onDeleted={() => setCurrent(null)} />
              ) : (
                <p className="hint">Cliquez sur un emplacement de l’arborescence pour voir et modifier ses caractéristiques.</p>
              ))}
            {panel === 'zone' && <ZonePanel depot={depot} onDone={done} onError={fail} />}
          </section>
        </aside>
      </div>
    </>
  );
}

function Chips({ locs, selected, current, onPick, onToggle }: { locs: Loc[]; selected: Set<string>; current: string | null; onPick: (l: Loc) => void; onToggle: (l: Loc) => void }) {
  return (
    <ul className="loc-chips">
      {locs.map((l) => {
        const state = l.statut !== 'ACTIF' ? 'off' : l.articles + l.um > 0 ? 'busy' : 'free';
        return (
          <li key={l.id} className={`loc-chip ${state}${current === l.id ? ' current' : ''}`}>
            <input type="checkbox" checked={selected.has(l.id)} onChange={() => onToggle(l)} aria-label={`Sélectionner ${l.code}`} />
            <button
              type="button"
              onClick={() => onPick(l)}
              title={`${l.chemin} · ${LOC_STATUS[l.statut]}${l.articles ? ` · ${plural(l.articles, 'article')}` : ''}`}
            >
              {l.code}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Generator({ depot, zoneId, setZoneId, onDone, onError }: { depot: Depot; zoneId: string; setZoneId: (z: string) => void; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [allees, setAllees] = useState('');
  const [niveaux, setNiveaux] = useState('');
  const [cases, setCases] = useState('1-10');
  const [template, setTemplate] = useState('');
  const [type, setType] = useState('RACK');
  const [L, setL] = useState('1,2');
  const [l, setLw] = useState('0,8');
  const [H, setH] = useState('');
  const [charge, setCharge] = useState('');
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<{ total: number; nouveaux: number; existants: number; surfaceTotaleM2: number } | null>(null);
  const zone = depot.zones.find((z) => z.id === zoneId);
  // aperçu immédiat avec la même règle que le serveur ; le serveur ajoute les codes déjà pris
  const local = zone ? expandLocationPattern({ depotCode: depot.code, zoneCode: zone.code, allees, niveaux, cases, template: template || undefined }) : null;
  useEffect(() => setServer(null), [zoneId, allees, niveaux, cases, template]);
  const body = (dryRun: boolean) => ({
    zoneId,
    allees: allees || undefined,
    niveaux: niveaux || undefined,
    cases,
    template: template || undefined,
    type,
    longueurM: num(L),
    largeurM: num(l),
    hauteurM: num(H),
    chargeMaxKg: num(charge),
    dryRun,
  });
  const surface = num(L) != null && num(l) != null ? Math.round(num(L)! * num(l)! * 100) / 100 : null;

  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          if (!server) setServer(await post('/bo/warehouse/emplacements/generate', body(true)));
          else {
            const r = await post<{ cree: number }>('/bo/warehouse/emplacements/generate', body(false));
            setServer(null);
            onDone(`${plural(r.cree, 'emplacement créé', 'emplacements créés')} dans ${zone?.nom}. Imprimez leurs étiquettes depuis l’arborescence.`);
          }
        } catch (err) {
          onError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>Générer des emplacements</h3>
      <label>
        Zone
        <select value={zoneId} onChange={(e) => setZoneId(e.target.value)} required>
          {depot.zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.nom} ({z.code})
            </option>
          ))}
        </select>
      </label>
      <div className="row">
        <label>
          Allées
          <input value={allees} onChange={(e) => setAllees(e.target.value)} placeholder="4 ou 1-3" />
        </label>
        <label>
          Niveaux
          <input value={niveaux} onChange={(e) => setNiveaux(e.target.value)} placeholder="1-5" />
        </label>
        <label>
          Cases
          <input value={cases} onChange={(e) => setCases(e.target.value)} required placeholder="1-20" />
        </label>
      </div>
      <p className="hint">Laissez « Allées » vide pour des emplacements au sol, « Niveaux » vide pour un seul niveau.</p>
      <div className="row">
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(LOC_TYPE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Charge max (kg)
          <input inputMode="decimal" value={charge} onChange={(e) => setCharge(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <label>
          L (m)
          <input inputMode="decimal" value={L} onChange={(e) => setL(e.target.value)} />
        </label>
        <label>
          l (m)
          <input inputMode="decimal" value={l} onChange={(e) => setLw(e.target.value)} />
        </label>
        <label>
          H (m)
          <input inputMode="decimal" value={H} onChange={(e) => setH(e.target.value)} />
        </label>
      </div>
      <details>
        <summary>Gabarit du code</summary>
        <label>
          Gabarit
          <input value={template} onChange={(e) => setTemplate(e.target.value)} placeholder="{D}-{Z}-{A}-{N}{C}" className="mono" />
        </label>
        <p className="hint">
          {'{D}'} dépôt, {'{Z}'} zone, {'{A}'} allée sur 2 chiffres, {'{N}'} niveau, {'{C}'} case sur 2 chiffres.
        </p>
      </details>
      {local && !local.ok && <p className="field-error">{local.error}</p>}
      {local && local.ok && (
        <div className="preview-box">
          <p>
            <strong>{plural(local.locations.length, 'emplacement')}</strong>
            {surface != null && <> · {m2(surface)} chacun</>}
            {server && server.existants > 0 && <> · {server.existants} existent déjà et seront ignorés</>}
          </p>
          <p className="mono codes">
            {local.locations.slice(0, 4).map((x) => x.code).join('  ')}
            {local.locations.length > 5 && '  …  '}
            {local.locations.length > 4 && local.locations.at(-1)!.code}
          </p>
          <p className="muted small">
            {zone?.nom} › {local.locations[0]!.chemin.join(' › ')}
          </p>
        </div>
      )}
      <button type="submit" className="btn primary" disabled={busy || !local?.ok || (server != null && server.nouveaux === 0)}>
        {busy ? '…' : server ? `Créer ${plural(server.nouveaux, 'emplacement')}` : 'Vérifier'}
      </button>
    </form>
  );
}

function CsvImport({ depot, onDone, onError }: { depot: Depot; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [csv, setCsv] = useState('');
  const [name, setName] = useState<string | null>(null);
  const [res, setRes] = useState<{ lignes: number; valides: number; nbErreurs: number; erreurs: { line: number; message: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await post<{ lignes: number; valides: number; nbErreurs: number; erreurs: { line: number; message: string }[]; cree: number }>(`/bo/warehouse/depots/${depot.id}/import`, { csv, dryRun });
      if (dryRun) setRes(r);
      else {
        setRes(null);
        setCsv('');
        setName(null);
        onDone(`${plural(r.cree, 'emplacement importé', 'emplacements importés')}.`);
      }
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const template = `zone;code;type;longueur_m;largeur_m;hauteur_m;surface_m2;charge_max_kg;statut;libelle\n${depot.zones[0]?.code ?? 'B'};${depot.code}-${depot.zones[0]?.code ?? 'B'}-S01;SOL;4;3;;;;ACTIF;Sol 1\n`;
  return (
    <div className="stack">
      <h3>Importer un fichier CSV</h3>
      <p className="hint">
        Une ligne par emplacement, séparateur « ; » ou « , ». Colonnes : <span className="mono">zone, code</span> (obligatoires), type, longueur_m, largeur_m, hauteur_m, surface_m2, charge_max_kg,
        statut, libelle.{' '}
        <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(template)}`} download="modele-emplacements.csv">
          Télécharger le modèle
        </a>
      </p>
      <label className="file-drop">
        <input
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setName(f.name);
            setCsv(await f.text());
            setRes(null);
          }}
        />
        {name ? <strong>{name}</strong> : 'Choisir un fichier…'}
      </label>
      {res && (
        <div className="preview-box">
          <p>
            <strong>{plural(res.valides, 'ligne valide', 'lignes valides')}</strong> sur {res.lignes}
            {res.nbErreurs > 0 && <> · {plural(res.nbErreurs, 'erreur')}</>}
          </p>
          {res.erreurs.length > 0 && (
            <ul className="errors">
              {res.erreurs.slice(0, 8).map((er) => (
                <li key={`${er.line}-${er.message}`}>
                  Ligne {er.line} : {er.message}
                </li>
              ))}
              {res.erreurs.length > 8 && <li>…</li>}
            </ul>
          )}
        </div>
      )}
      <button type="button" className="btn primary" disabled={!csv || busy || (res != null && (res.nbErreurs > 0 || res.valides === 0))} onClick={() => void run(!res)}>
        {busy ? '…' : res ? `Importer ${plural(res.valides, 'emplacement')}` : 'Vérifier le fichier'}
      </button>
    </div>
  );
}

export function LabelsPanel({ ids, kind = 'EMPLACEMENT', onClear, onError }: { ids: string[]; kind?: 'EMPLACEMENT' | 'ARTICLE'; onClear?: () => void; onError: (m: string) => void }) {
  const [format, setFormat] = useState('L7160');
  const [skip, setSkip] = useState('0');
  const [busy, setBusy] = useState(false);
  const zebra = format.startsWith('ZEBRA');
  const print = async (sortie: 'PDF' | 'ZPL') => {
    setBusy(true);
    try {
      const blob = await apiBlob('/bo/warehouse/labels', { method: 'POST', body: JSON.stringify({ kind, ids, format, sortie, skip: zebra ? 0 : Number(skip) || 0 }) });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `etiquettes-${new Date().toISOString().slice(0, 10)}.${sortie === 'ZPL' ? 'zpl' : 'pdf'}`;
      if (sortie === 'PDF') a.target = '_blank';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <h3>Imprimer les étiquettes</h3>
      {!ids.length ? (
        <p className="hint">{kind === 'EMPLACEMENT' ? 'Cochez des emplacements dans l’arborescence (ou « tout » sur une zone ou une allée).' : 'Aucun article choisi.'}</p>
      ) : (
        <p>
          <strong>{plural(ids.length, 'étiquette')}</strong> : QR, code lisible et nom du dépôt.{' '}
          {onClear && (
            <button type="button" className="link-like" onClick={onClear}>
              Vider la sélection
            </button>
          )}
        </p>
      )}
      <label>
        Format
        <select value={format} onChange={(e) => setFormat(e.target.value)}>
          <optgroup label="Planche A4 (imprimante de bureau)">
            {AVERY_FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.nom}
              </option>
            ))}
          </optgroup>
          <optgroup label="Imprimante thermique Zebra">
            {ZEBRA_FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.nom}
              </option>
            ))}
          </optgroup>
        </select>
      </label>
      {!zebra && (
        <label>
          Étiquettes déjà utilisées sur la première planche
          <input type="number" min={0} max={64} value={skip} onChange={(e) => setSkip(e.target.value)} />
        </label>
      )}
      <div className="row-actions">
        <button type="button" className="btn primary" disabled={!ids.length || busy} onClick={() => void print('PDF')}>
          {busy ? 'Préparation…' : 'PDF'}
        </button>
        {zebra && (
          <button type="button" className="btn" disabled={!ids.length || busy} onClick={() => void print('ZPL')}>
            Fichier ZPL (Zebra)
          </button>
        )}
      </div>
      {zebra && <p className="hint">Le fichier ZPL s’envoie tel quel à l’imprimante (Zebra Setup Utilities, ou copie sur le port de l’imprimante).</p>}
    </div>
  );
}

function LocationEditor({ loc, onDone, onError, onDeleted }: { loc: Loc; onDone: (m: string) => void; onError: (m: string) => void; onDeleted: () => void }) {
  const s = (n: number | null) => (n == null ? '' : String(n).replace('.', ','));
  const [type, setType] = useState(loc.type);
  const [statut, setStatut] = useState(loc.statut);
  const [L, setL] = useState(s(loc.longueurM));
  const [l, setLw] = useState(s(loc.largeurM));
  const [H, setH] = useState(s(loc.hauteurM));
  const [surface, setSurface] = useState(s(loc.surfaceM2));
  const [charge, setCharge] = useState(s(loc.chargeMaxKg));
  const [libelle, setLibelle] = useState(loc.chemin.split(' > ').at(-1) ?? '');
  const [motif, setMotif] = useState('');
  const [busy, setBusy] = useState(false);
  const needsMotif = statut !== 'ACTIF' && loc.statut === 'ACTIF' && loc.articles > 0;
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await put(`/bo/warehouse/emplacements/${loc.id}`, {
            type,
            statut,
            longueurM: num(L),
            largeurM: num(l),
            hauteurM: num(H),
            ...(num(surface) != null ? { surfaceM2: num(surface) } : {}),
            chargeMaxKg: num(charge),
            ...(libelle && libelle !== loc.chemin.split(' > ').at(-1) ? { libelle } : {}),
            ...(motif ? { motif } : {}),
          });
          onDone(`Emplacement ${loc.code} mis à jour.`);
        } catch (err) {
          onError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3 className="mono">{loc.code}</h3>
      <p className="muted small">{loc.chemin}</p>
      <p>
        {loc.adressable ? (
          <>
            <StatusPill label={LOC_STATUS[loc.statut] ?? loc.statut} tone={loc.statut === 'ACTIF' ? 'neutral' : 'alert'} />{' '}
            {loc.articles + loc.um > 0 ? `${plural(loc.articles, 'article')}${loc.um ? `, ${plural(loc.um, 'palette')}` : ''}` : 'Libre'}
          </>
        ) : (
          <span className="muted">Regroupement (allée) : ne reçoit pas d’article directement.</span>
        )}
      </p>
      <label>
        Libellé dans le chemin
        <input value={libelle} onChange={(e) => setLibelle(e.target.value)} />
      </label>
      <div className="row">
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(LOC_TYPE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {loc.adressable && (
          <label>
            Statut
            <select value={statut} onChange={(e) => setStatut(e.target.value)}>
              {Object.entries(LOC_STATUS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {loc.adressable && (
        <>
          <div className="row">
            <label>
              L (m)
              <input inputMode="decimal" value={L} onChange={(e) => setL(e.target.value)} />
            </label>
            <label>
              l (m)
              <input inputMode="decimal" value={l} onChange={(e) => setLw(e.target.value)} />
            </label>
            <label>
              H (m)
              <input inputMode="decimal" value={H} onChange={(e) => setH(e.target.value)} />
            </label>
          </div>
          <div className="row">
            <label>
              Surface au sol (m²)
              <input inputMode="decimal" value={surface} onChange={(e) => setSurface(e.target.value)} />
            </label>
            <label>
              Charge max (kg)
              <input inputMode="decimal" value={charge} onChange={(e) => setCharge(e.target.value)} />
            </label>
          </div>
        </>
      )}
      {needsMotif && (
        <label>
          Motif (emplacement occupé)
          <input value={motif} onChange={(e) => setMotif(e.target.value)} required minLength={3} placeholder="Lisse endommagée, contrôle sécurité…" />
        </label>
      )}
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          Enregistrer
        </button>
        <button
          type="button"
          className="btn ghost-dark"
          disabled={busy}
          onClick={async () => {
            if (!window.confirm(`Supprimer définitivement ${loc.code} ?`)) return;
            try {
              await del(`/bo/warehouse/emplacements/${loc.id}`);
              onDeleted();
              onDone(`Emplacement ${loc.code} supprimé.`);
            } catch (err) {
              onError((err as Error).message);
            }
          }}
        >
          Supprimer
        </button>
      </div>
      <p className="hint">Un emplacement déjà utilisé ne se supprime pas (l’historique y fait référence) : bloquez-le.</p>
    </form>
  );
}

function ZonePanel({ depot, onDone, onError }: { depot: Depot; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [code, setCode] = useState('');
  const [nom, setNom] = useState('');
  const [type, setType] = useState('STOCKAGE');
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack">
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await post('/bo/warehouse/zones', { depotId: depot.id, code, nom, type });
            setCode('');
            setNom('');
            onDone(`« ${nom} » créée.`);
          } catch (err) {
            onError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h3>Nouvelle zone</h3>
        <div className="row">
          <label>
            Code
            <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required maxLength={6} placeholder="C" />
          </label>
          <label>
            Nom
            <input value={nom} onChange={(e) => setNom(e.target.value)} required placeholder="Zone C" />
          </label>
        </div>
        <label>
          Usage
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {Object.entries(ZONE_TYPE).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn primary" disabled={busy}>
          Créer la zone
        </button>
      </form>
      {depot.zones.length > 0 && (
        <>
          <h3>Zones existantes</h3>
          <ul className="plain-list">
            {depot.zones.map((z) => (
              <li key={z.id}>
                <span>
                  <strong>{z.nom}</strong> <span className="mono muted">{z.code}</span> · {ZONE_TYPE[z.type]}
                </span>
                <button
                  type="button"
                  className="link-like"
                  onClick={async () => {
                    const n = window.prompt('Nouveau nom de la zone', z.nom);
                    if (!n || n === z.nom) return;
                    try {
                      await put(`/bo/warehouse/zones/${z.id}`, { nom: n });
                      onDone(`Zone renommée en « ${n} ».`);
                    } catch (err) {
                      onError((err as Error).message);
                    }
                  }}
                >
                  Renommer
                </button>
                <button
                  type="button"
                  className="link-like"
                  onClick={async () => {
                    try {
                      await api(`/bo/warehouse/zones/${z.id}`, { method: 'DELETE' });
                      onDone(`« ${z.nom} » supprimée.`);
                    } catch (err) {
                      onError((err as Error).message);
                    }
                  }}
                >
                  Supprimer
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
