import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import { href } from '../lib/router';
import type { Activity } from '../lib/types';
import { Banner, Pills, Thumb } from '../components/ui';

type Filtre = 'tout' | 'stock' | 'demandes' | 'documents';
const dayFr = (d: string) => new Date(d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
const timeFr = (d: string) => new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

/** Activités : tout ce qui s'est passé sur votre stock, du plus récent au plus ancien, jour par jour. */
export function Activities() {
  const [filtre, setFiltre] = useState<Filtre>('tout');
  const [items, setItems] = useState<Activity[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (f: Filtre, avant?: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await get<{ items: Activity[]; suivant: string | null }>(`/me/activites?filtre=${f}&limite=50${avant ? `&avant=${encodeURIComponent(avant)}` : ''}`);
      setItems((cur) => (avant ? [...(cur ?? []), ...r.items] : r.items));
      setNext(r.suivant);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setItems(null);
    void load(filtre);
  }, [filtre]);

  // regroupement par jour (heure de Paris)
  const days: { day: string; items: Activity[] }[] = [];
  for (const a of items ?? []) {
    const d = dayFr(a.le);
    const last = days[days.length - 1];
    if (last?.day === d) last.items.push(a);
    else days.push({ day: d, items: [a] });
  }

  return (
    <>
      <section className="page-head">
        <span className="eyebrow">— Historique</span>
        <h1>Activités</h1>
        <p className="lead">Chaque entrée au dépôt, livraison, retour, demande et document signé, daté à la minute.</p>
      </section>
      <Pills<Filtre>
        label="Filtre"
        value={filtre}
        onChange={setFiltre}
        options={[
          { value: 'tout', label: 'Tout' },
          { value: 'stock', label: 'Mouvements des biens' },
          { value: 'demandes', label: 'Demandes' },
          { value: 'documents', label: 'Documents signés' },
        ]}
      />
      {error && <Banner kind="error">{error}</Banner>}
      {!items && !error && <p className="hint">Chargement…</p>}
      {items && items.length === 0 && <p className="empty">Aucune activité pour l’instant.</p>}
      {days.map((d) => (
        <section key={d.day} className="activity-day">
          <h2>{d.day}</h2>
          <ul className="activity-list">
            {d.items.map((a) => (
              <li key={a.id} className={`genre-${a.genre.toLowerCase()}`}>
                <span className="activity-time">{timeFr(a.le)}</span>
                {a.article ? <Thumb src={a.vignette} alt="" /> : <span className="activity-icon" aria-hidden="true">{a.genre === 'DEMANDE' ? '↗' : '✎'}</span>}
                <div>
                  <strong>{a.titre}</strong>
                  {a.article && (
                    <a href={href({ name: 'article', id: a.article.id })}>
                      {a.article.libelle} <span className="mono hint small">{a.article.qr}</span>
                    </a>
                  )}
                  {a.commande && (
                    <a href={href({ name: 'commande', id: a.commande.id })}>
                      Demande <span className="mono">{a.commande.numero ?? '—'}</span>
                    </a>
                  )}
                  <span className="hint small">{[a.document ? `N° ${a.document.numero}` : null, a.texte, a.projet].filter(Boolean).join(' · ')}</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {next && (
        <button type="button" className="btn secondary" disabled={busy} onClick={() => void load(filtre, next)}>
          {busy ? 'Chargement…' : 'Voir les activités plus anciennes'}
        </button>
      )}
    </>
  );
}
