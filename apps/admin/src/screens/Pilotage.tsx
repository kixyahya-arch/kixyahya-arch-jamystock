import { useCallback, useEffect, useState } from 'react';
import { get } from '../lib/api';
import { href } from '../lib/router';
import { MISSION_STATUS, MISSION_TYPE, ORDER_STATUS, ORDER_TYPE, dateFr, dateShort, euros, m2, timeFr } from '../lib/labels';
import { Banner, Tile } from '../components/ui';
import { SurfaceChart } from './Billing';

/** CLI-03 : tableau de bord de pilotage du Super Admin, rechargé toutes les 15 minutes, exportable en CSV. */

interface Depot {
  id: string;
  nom: string;
  code: string;
  surfaceTotaleM2: number | null;
  surfaceStockageM2: number;
  occupeeM2: number;
  emplacements: number;
  emplacementsOccupes: number;
  articles: number;
  taux: number | null;
}
interface Data {
  maj: string;
  today: string;
  depots: Depot[];
  surfaceFacturee: { date: string; m2: number } | null;
  tendance: { date: string; m2: number }[];
  ca: { recurrentCents: number; clientsSousForfait: number; factureMoisHtCents: number; factureMoisPrecedentHtCents: number; aEncaisserCents: number; echuCents: number };
  missions: { total: number; lignes: { type: string; statut: string; n: number }[] };
  retards: {
    commandes: { id: string; numero: string | null; type: string; statut: string; client: string; date: string }[];
    missions: number;
    factures: { id: string; numero: string; client: string; echeance: string; totalTtcCents: number; relanceNiveau: number }[];
  };
}

const REFRESH_MS = 15 * 60_000;
const pct = (n: number | null) => (n == null ? '—' : `${n.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`);
const MISSION_COLUMNS = ['A_AFFECTER', 'AFFECTEE', 'EN_COURS', 'TERMINEE', 'ANOMALIE'];

export function Pilotage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    get<Data>('/bo/pilotage')
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  if (!data) return error ? <Banner kind="error">{error}</Banner> : <p className="hint">Chargement…</p>;
  const { ca, retards } = data;
  const missionTypes = [...new Set(data.missions.lignes.map((l) => l.type))].sort();
  const missionCount = (type: string, statut: string) => data.missions.lignes.find((l) => l.type === type && l.statut === statut)?.n ?? 0;
  const lateCount = retards.commandes.length + retards.missions + retards.factures.length;

  return (
    <>
      <section className="bo-head">
        <div>
          <p className="eyebrow">— Pilotage</p>
          <h1>Tableau de bord</h1>
          <p className="lead">
            Mis à jour à {timeFr(data.maj)}, rechargé toutes les 15 minutes.{' '}
            <button type="button" className="link-button" onClick={load} disabled={loading}>
              {loading ? 'Actualisation…' : 'Actualiser'}
            </button>
          </p>
        </div>
        <div className="head-status">
          <button type="button" className="btn" onClick={() => downloadCsv(data)}>
            Exporter en CSV
          </button>
        </div>
      </section>
      {error && <Banner kind="error">{error}</Banner>}

      <section className="tiles" aria-label="Indicateurs clés">
        <Tile n={euros(ca.recurrentCents)} label={`CA récurrent HT par mois (${ca.clientsSousForfait} forfait${ca.clientsSousForfait > 1 ? 's' : ''})`} accent />
        <Tile n={data.surfaceFacturee ? m2(data.surfaceFacturee.m2) : '—'} label={data.surfaceFacturee ? `occupés chez les clients le ${dateShort(data.surfaceFacturee.date)}` : 'aucun relevé de surface'} />
        <Tile n={data.missions.total} label="missions prévues aujourd’hui" href={href({ name: 'planning' })} />
        <Tile n={lateCount} label="retards à traiter" alert={lateCount > 0} />
        <Tile n={euros(ca.echuCents)} label={`échus sur ${euros(ca.aEncaisserCents)} à encaisser`} alert={ca.echuCents > 0} href={href({ name: 'facturation' })} />
      </section>

      <div className="two-col">
        <div className="col-main">
          <section className="panel">
            <h2>Remplissage des dépôts</h2>
            <p className="hint">Surface des emplacements de stockage occupés (un bien, une unité de manutention ou un client dédié) sur la surface de tous les emplacements de stockage actifs.</p>
            <div className="table-wrap flat">
              <table className="table compact">
                <thead>
                  <tr>
                    <th>Dépôt</th>
                    <th className="num">Occupé</th>
                    <th className="num">Stockage</th>
                    <th style={{ width: '28%' }}>Remplissage</th>
                    <th className="num">Emplacements</th>
                    <th className="num">Biens</th>
                  </tr>
                </thead>
                <tbody>
                  {data.depots.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <a href={href({ name: 'depot', id: d.id })}>{d.nom}</a>
                        <div className="muted mono">{d.code}</div>
                      </td>
                      <td className="num">{m2(d.occupeeM2)}</td>
                      <td className="num">{m2(d.surfaceStockageM2)}</td>
                      <td>
                        <div className="fill-cell">
                          <span className={`meter ${d.taux != null && d.taux >= 95 ? 'depassement' : d.taux != null && d.taux >= 85 ? 'attention' : ''}`} title={pct(d.taux)}>
                            <span style={{ width: `${Math.min(d.taux ?? 0, 100)}%` }} />
                          </span>
                          <strong>{pct(d.taux)}</strong>
                        </div>
                      </td>
                      <td className="num">
                        {d.emplacementsOccupes} / {d.emplacements}
                      </td>
                      <td className="num">{d.articles}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {data.tendance.length > 1 && (
            <section className="panel">
              <h2>Surface occupée chez les clients, 60 derniers jours</h2>
              <SurfaceChart days={data.tendance.map((d) => ({ date: d.date, m2: d.m2, source: 'AUTO', motif: null }))} included={null} />
            </section>
          )}

          <section className="panel">
            <h2>Retards</h2>
            {lateCount === 0 ? (
              <p className="hint">Aucun retard : toutes les commandes, missions et factures sont dans les temps.</p>
            ) : (
              <>
                {retards.missions > 0 && (
                  <p>
                    <strong>{retards.missions}</strong> mission{retards.missions > 1 ? 's' : ''} pas encore démarrée{retards.missions > 1 ? 's' : ''} à l’heure prévue.{' '}
                    <a href={href({ name: 'planning' })}>Voir le planning</a>
                  </p>
                )}
                {retards.commandes.length > 0 && (
                  <>
                    <h3>Commandes dont la date est passée</h3>
                    <ul className="plain">
                      {retards.commandes.map((c) => (
                        <li key={c.id}>
                          <a className="mono" href={href({ name: 'demande', id: c.id })}>
                            {c.numero ?? 'Sans numéro'}
                          </a>{' '}
                          <span className="muted">
                            {c.client} · {ORDER_TYPE[c.type] ?? c.type} prévue le {dateShort(c.date)} · {ORDER_STATUS[c.statut] ?? c.statut}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {retards.factures.length > 0 && (
                  <>
                    <h3>Factures échues</h3>
                    <ul className="plain">
                      {retards.factures.map((f) => (
                        <li key={f.id}>
                          <a className="mono" href={href({ name: 'facture', id: f.id })}>
                            {f.numero}
                          </a>{' '}
                          <span className="muted">
                            {f.client} · {euros(f.totalTtcCents)} TTC · échéance {dateShort(f.echeance)}
                            {f.relanceNiveau ? ` · relance ${f.relanceNiveau}/3` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </section>
        </div>

        <aside className="col-side">
          <section className="panel">
            <h2>Chiffre d’affaires</h2>
            <dl className="facts">
              <dt>Forfaits actifs, par mois</dt>
              <dd>{euros(ca.recurrentCents)} HT</dd>
              <dt>Facturé ce mois-ci</dt>
              <dd>{euros(ca.factureMoisHtCents)} HT</dd>
              <dt>Facturé le mois dernier</dt>
              <dd>{euros(ca.factureMoisPrecedentHtCents)} HT</dd>
              <dt>À encaisser</dt>
              <dd>{euros(ca.aEncaisserCents)} TTC</dd>
              <dt>Dont échu</dt>
              <dd className={ca.echuCents > 0 ? 'alert-text' : ''}>{euros(ca.echuCents)} TTC</dd>
            </dl>
          </section>

          <section className="panel">
            <h2>Missions du {dateFr(data.today)}</h2>
            {data.missions.total === 0 ? (
              <p className="hint">Aucune mission prévue aujourd’hui.</p>
            ) : (
              <div className="table-wrap flat">
                <table className="table compact">
                  <thead>
                    <tr>
                      <th>Type</th>
                      {MISSION_COLUMNS.map((s) => (
                        <th key={s} className="num">
                          {MISSION_STATUS[s] ?? s}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {missionTypes.map((t) => (
                      <tr key={t}>
                        <td>{MISSION_TYPE[t] ?? t}</td>
                        {MISSION_COLUMNS.map((s) => (
                          <td key={s} className="num">
                            {missionCount(t, s) || <span className="muted">0</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

/** Export CSV des indicateurs (séparateur point-virgule, virgule décimale : s'ouvre tel quel dans Excel). */
function downloadCsv(d: Data) {
  const num = (n: number | null) => (n == null ? '' : String(n).replace('.', ','));
  const cell = (v: string | number | null) => {
    const s = typeof v === 'number' ? num(v) : (v ?? '');
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows: (string | number | null)[][] = [
    ['Indicateur', 'Détail', 'Valeur', 'Unité'],
    ['Mis à jour', '', d.maj, ''],
    ['CA récurrent', 'forfaits actifs', d.ca.recurrentCents / 100, 'EUR HT / mois'],
    ['Facturé', 'mois en cours', d.ca.factureMoisHtCents / 100, 'EUR HT'],
    ['Facturé', 'mois précédent', d.ca.factureMoisPrecedentHtCents / 100, 'EUR HT'],
    ['À encaisser', '', d.ca.aEncaisserCents / 100, 'EUR TTC'],
    ['Échu', '', d.ca.echuCents / 100, 'EUR TTC'],
    ['Surface occupée clients', d.surfaceFacturee?.date ?? '', d.surfaceFacturee?.m2 ?? null, 'm²'],
    ...d.depots.flatMap((x) => [
      ['Dépôt occupé', x.nom, x.occupeeM2, 'm²'],
      ['Dépôt stockage', x.nom, x.surfaceStockageM2, 'm²'],
      ['Dépôt remplissage', x.nom, x.taux, '%'],
      ['Dépôt emplacements occupés', x.nom, x.emplacementsOccupes, `sur ${x.emplacements}`],
    ]),
    ['Missions du jour', d.today, d.missions.total, 'missions'],
    ...d.missions.lignes.map((l) => ['Missions du jour', `${MISSION_TYPE[l.type] ?? l.type} · ${MISSION_STATUS[l.statut] ?? l.statut}`, l.n, 'missions']),
    ['Retards', 'commandes', d.retards.commandes.length, 'commandes'],
    ['Retards', 'missions non démarrées', d.retards.missions, 'missions'],
    ['Retards', 'factures échues', d.retards.factures.length, 'factures'],
  ];
  const csv = `﻿${rows.map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `pilotage-${d.today}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
