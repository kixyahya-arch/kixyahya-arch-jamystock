import { useState } from 'react';
import { get, post } from '../lib/api';
import { href } from '../lib/router';
import type { Surface, SurfaceMonth } from '../lib/types';

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
            {s.m2Occupes === 0 && s.nbArticles > 0 && (s.sansDimensions ?? 0) + (s.nonRanges ?? 0) > 0 ? 'À mesurer' : `${fmt(s.m2Occupes)} m²`}
            {s.m2Inclus !== null && <span> / {fmt(s.m2Inclus)} m² inclus</span>}
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
                ? `Vous approchez de votre forfait (${fmt(s.taux ?? 0)} %).`
                : `${fmt(s.taux ?? 0)} % de votre forfait utilisé.`}
          </p>
        </>
      )}
      {((s.sansDimensions ?? 0) > 0 || (s.nonRanges ?? 0) > 0) && (
        <p className="gauge-note">
          {[
            (s.sansDimensions ?? 0) > 0 && `${s.sansDimensions} bien${s.sansDimensions! > 1 ? 's' : ''} sans dimensions`,
            (s.nonRanges ?? 0) > 0 && `${s.nonRanges} en cours de rangement`,
          ]
            .filter(Boolean)
            .join(' et ')}{' '}
          : leur surface sera comptée dès qu’ils auront été mesurés et rangés au dépôt.
        </p>
      )}
      {(s.parDepot?.length ?? 0) > 1 && (
        <ul className="by-project">
          {s.parDepot!.map((d) => (
            <li key={d.depotId}>
              <span>{d.nom}</span>
              <span>
                {fmt(d.m2)} m² · {d.nbArticles} biens
              </span>
            </li>
          ))}
        </ul>
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
      <History inclus={s.m2Inclus} />
      <div className="gauge-actions">
        <a href={href({ name: 'dormants' })}>Biens sans mouvement depuis un an</a>
        {s.perimetre === 'ENTREPRISE' && s.m2Inclus !== null && <Upgrade s={s} />}
      </div>
    </section>
  );
}

/** RG-AL-02 : « Passer au forfait supérieur » : la demande part à JAMYSTOCK, qui revient vers le client. */
function Upgrade({ s }: { s: Surface }) {
  const [open, setOpen] = useState(false);
  const [m2, setM2] = useState('');
  const [message, setMessage] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'error'>('idle');
  if (state === 'sent') return <span className="hint">Demande envoyée : JAMYSTOCK revient vers vous avec une proposition.</span>;
  if (!open)
    return (
      <button type="button" className="btn secondary small" onClick={() => setOpen(true)}>
        Demander un forfait supérieur
      </button>
    );
  const send = async () => {
    setState('busy');
    try {
      await post('/me/forfait/demande', { ...(Number(m2) > 0 ? { m2Souhaites: Number(m2) } : {}), ...(message.trim() ? { message: message.trim() } : {}) });
      setState('sent');
    } catch {
      setState('error');
    }
  };
  return (
    <form
      className="upgrade-form"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <label>
        Surface souhaitée (m², facultatif)
        <input type="number" min={1} step={1} value={m2} onChange={(e) => setM2(e.target.value)} placeholder={s.m2Inclus ? String(Math.ceil(s.m2Inclus * 1.25)) : ''} />
      </label>
      <label>
        Message (facultatif)
        <textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Ex. : arrivée de 40 m² de mobilier en mars" />
      </label>
      {state === 'error' && <p className="hint error-text">Envoi impossible pour le moment, réessayez.</p>}
      <div className="row-actions">
        <button type="submit" className="btn primary small" disabled={state === 'busy'}>
          {state === 'busy' ? 'Envoi…' : 'Envoyer la demande'}
        </button>
        <button type="button" className="btn ghost small" onClick={() => setOpen(false)}>
          Annuler
        </button>
      </div>
    </form>
  );
}

const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

/** ADM-01 : courbe d'évolution sur 12 mois (moyenne mensuelle des m², repère du forfait), chargée à l'ouverture. */
function History({ inclus }: { inclus: number | null }) {
  const [rows, setRows] = useState<SurfaceMonth[] | null>(null);
  const [error, setError] = useState(false);
  const load = () => {
    if (rows || error) return;
    get<SurfaceMonth[]>('/me/surface/historique').then(setRows, () => setError(true));
  };
  const max = Math.max(inclus ?? 0, ...(rows ?? []).map((r) => r.pic ?? 0), 1);
  const W = 360;
  const H = 120;
  const bw = W / 12;
  const y = (v: number) => H - (v / max) * (H - 8);
  return (
    <details className="gauge-history" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && load()}>
      <summary>Évolution sur 12 mois</summary>
      {error && <p className="hint">Courbe indisponible pour le moment.</p>}
      {!rows && !error && <p className="hint">Chargement…</p>}
      {rows && rows.every((r) => r.moyenne === null) && <p className="hint">La courbe se remplit au fil des jours, à partir de votre premier mois de stockage.</p>}
      {rows && rows.some((r) => r.moyenne !== null) && (
        <svg viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label="Surface moyenne occupée par mois sur 12 mois">
          {inclus !== null && <line className="quota" x1={0} x2={W} y1={y(inclus)} y2={y(inclus)} />}
          {rows.map((r, i) => {
            const m = Number(r.mois.slice(5, 7)) - 1;
            return (
              <g key={r.mois}>
                {r.moyenne !== null && (
                  <rect className={inclus !== null && r.moyenne > inclus ? 'over' : ''} x={i * bw + 3} width={bw - 6} y={y(r.moyenne)} height={H - y(r.moyenne)} rx={2}>
                    <title>{`${MOIS[m]} ${r.mois.slice(0, 4)} : ${fmt(r.moyenne)} m² en moyenne, pic ${fmt(r.pic ?? r.moyenne)} m²`}</title>
                  </rect>
                )}
                <text x={i * bw + bw / 2} y={H + 13} textAnchor="middle">
                  {MOIS[m]}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {rows && inclus !== null && rows.some((r) => r.moyenne !== null) && <p className="hint">Trait pointillé : m² inclus dans votre forfait.</p>}
    </details>
  );
}
