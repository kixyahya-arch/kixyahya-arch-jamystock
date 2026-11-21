import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import { addToCart } from '../lib/cart';
import { go, href } from '../lib/router';
import type { DormantReport } from '../lib/types';
import { Banner, Thumb } from '../components/ui';

const fmt = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
const dateFr = (d: string) => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
/** mois calendaires pleins écoulés depuis la date */
const mois = (d: string) => {
  const a = new Date(d);
  const b = new Date();
  return (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth() - (b.getDate() < a.getDate() ? 1 : 0);
};

/**
 * RG-AL-05 : rapport des biens dormants (au dépôt, sans mouvement depuis 12 mois). Le client choisit ceux qu'il
 * se fait livrer pour libérer de la surface ; la liste s'exporte en CSV pour circuler en interne.
 */
export function Dormants() {
  const [r, setR] = useState<DormantReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<DormantReport>('/me/dormants').then(setR, (e) => setError((e as Error).message));
  }, []);

  if (!r) return error ? <Banner kind="error">{error}</Banner> : <p className="hint">Chargement…</p>;
  const free = r.items.filter((a) => !a.reserve);
  const toggle = (id: string) => {
    const n = new Set(chosen);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setChosen(n);
  };
  const m2Chosen = r.items.filter((a) => chosen.has(a.id)).reduce((t, a) => t + (a.m2 ?? 0), 0);

  const deliver = async () => {
    setBusy(true);
    setError(null);
    try {
      for (const a of r.items.filter((x) => chosen.has(x.id))) await addToCart(a.id, a.projetId);
      go({ name: 'panier' });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const csv = () => {
    const cell = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['Bien', 'Étiquette', 'Projet', 'Dernier mouvement', 'Mois sans mouvement', 'Surface au sol (m²)'].map(cell).join(';'),
      ...r.items.map((a) => [a.libelle, a.qr, a.projet, new Date(a.depuis).toISOString().slice(0, 10), mois(a.depuis), a.m2 === null ? '' : String(a.m2).replace('.', ',')].map(cell).join(';')),
    ];
    const url = URL.createObjectURL(new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `biens-dormants-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <>
      <a className="back-link" href={href({ name: 'inventaire' })}>
        ← Mon stock
      </a>
      <section className="page-head">
        <span className="eyebrow">— Rapport</span>
        <h1>Biens dormants</h1>
        <p className="lead">
          Biens au dépôt sans aucun mouvement depuis au moins {r.depuisMois} mois. Les faire livrer libère de la surface et allège votre forfait.
        </p>
      </section>

      {r.total === 0 ? (
        <Banner kind="ok">Aucun bien dormant : tout votre stock a bougé au cours des 12 derniers mois.</Banner>
      ) : (
        <>
          <div className="dormant-summary">
            <p>
              <strong>{r.total}</strong> bien{r.total > 1 ? 's' : ''}
              {r.m2 > 0 && (
                <>
                  {' '}
                  · <strong>{fmt(r.m2)} m²</strong> au sol
                </>
              )}
              {r.sansDimensions > 0 && <span className="hint"> ({r.sansDimensions} sans dimensions, mesurés à leur prochain passage)</span>}
            </p>
            <div className="row-actions">
              <button type="button" className="btn secondary" onClick={csv}>
                Exporter en CSV
              </button>
              {free.length > 0 && (
                <button type="button" className="btn secondary" onClick={() => setChosen(chosen.size === free.length ? new Set() : new Set(free.map((a) => a.id)))}>
                  {chosen.size === free.length ? 'Tout désélectionner' : 'Tout sélectionner'}
                </button>
              )}
            </div>
          </div>
          {error && <Banner kind="error">{error}</Banner>}
          <ul className="dormant-list">
            {r.items.map((a) => (
              <li key={a.id} className={chosen.has(a.id) ? 'on' : ''}>
                <label className="check" title={a.reserve ? 'Déjà dans une demande' : undefined}>
                  <input type="checkbox" checked={chosen.has(a.id)} disabled={a.reserve} onChange={() => toggle(a.id)} aria-label={`Choisir ${a.libelle}`} />
                </label>
                <Thumb src={a.vignette} alt="" />
                <div>
                  <a href={href({ name: 'article', id: a.id })}>{a.libelle}</a>
                  <span className="hint small">
                    <span className="mono">{a.qr}</span>
                    {a.projet ? ` · ${a.projet}` : ''}
                  </span>
                </div>
                <div className="dormant-meta">
                  <strong>{mois(a.depuis)} mois</strong>
                  <span className="hint small">depuis le {dateFr(a.depuis)}</span>
                </div>
                <div className="dormant-meta">{a.m2 === null ? <span className="hint small">à mesurer</span> : `${fmt(a.m2)} m²`}</div>
              </li>
            ))}
          </ul>
          {chosen.size > 0 && (
            <div className="sticky-action">
              <span>
                {chosen.size} bien{chosen.size > 1 ? 's' : ''} choisi{chosen.size > 1 ? 's' : ''}
                {m2Chosen > 0 ? ` · ${fmt(m2Chosen)} m² libérés` : ''}
              </span>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void deliver()}>
                {busy ? 'Ajout…' : 'Me les faire livrer'}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
