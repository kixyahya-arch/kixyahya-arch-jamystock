import type { Surface } from '../lib/types';

const fmt = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 1 });

/** ADM-01 : surface occupée en temps réel face au forfait, ventilée par projet pour un B2B (INV-04). */
export function Gauge({ s }: { s: Surface }) {
  const pct = s.m2Inclus ? Math.min(100, (s.m2Occupes / s.m2Inclus) * 100) : 0;
  const tone = s.niveau === 'DEPASSEMENT' ? 'over' : s.niveau === 'ATTENTION' ? 'warn' : 'ok';
  return (
    <section className={`gauge ${tone}`} aria-label="Surface occupée">
      <div className="gauge-head">
        <div>
          <span className="eyebrow">Surface occupée {s.perimetre === 'PROJETS' ? '· mes projets' : ''}</span>
          <p className="gauge-value">
            {fmt(s.m2Occupes)} m²{s.m2Inclus !== null && <span> / {fmt(s.m2Inclus)} m² inclus</span>}
          </p>
        </div>
        <div className="gauge-side">
          <strong>{s.nbArticles}</strong> biens au dépôt
        </div>
      </div>
      {s.m2Inclus !== null && (
        <>
          <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <p className="gauge-note">
            {s.niveau === 'DEPASSEMENT'
              ? `Forfait dépassé de ${fmt(s.m2Occupes - s.m2Inclus)} m² : le dépassement sera facturé au prorata.`
              : s.niveau === 'ATTENTION'
                ? `Vous approchez de votre forfait (${s.taux} %).`
                : `${s.taux} % de votre forfait utilisé.`}
          </p>
        </>
      )}
      {s.parProjet.length > 1 && (
        <ul className="by-project">
          {s.parProjet.map((p) => (
            <li key={p.projetId}>
              <span>{p.nom}</span>
              <span>
                {fmt(p.m2)} m² · {p.nbArticles} biens
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
