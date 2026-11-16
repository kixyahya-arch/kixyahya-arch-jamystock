import { useEffect, useState } from 'react';
import { loadBootstrap, type Bootstrap, type MissionSummary } from '../lib/data';
import { canLogout, rejectedItems, dismissRejected } from '../lib/outbox';
import { logout, type Session } from '../lib/api';
import { Banner, Screen } from '../components/ui';
import type { Route } from '../App';

const TYPE_LABEL: Record<string, string> = {
  PREPARATION: 'Préparation',
  LIVRAISON: 'Livraison',
  COLLECTE: 'Collecte',
  RETRAIT: 'Retrait au comptoir',
  INVENTAIRE: 'Inventaire',
  PHOTO: 'Photo à la demande',
};

export function Home({ session, go, onLogout }: { session: Session; go: (r: Route) => void; onLogout: () => void }) {
  const [boot, setBoot] = useState<Bootstrap | undefined>();
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<Awaited<ReturnType<typeof rejectedItems>>>([]);

  const reload = async () => {
    try {
      const r = await loadBootstrap();
      setBoot(r.data);
      setOffline(r.offline);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    setRejected(await rejectedItems());
  };
  useEffect(() => void reload(), []);

  const role = session.user?.role ?? '';
  const isOperator = role === 'OPERATOR' || role === 'SUPER_ADMIN';
  const missions = boot?.missions ?? [];

  return (
    <Screen title={`Bonjour ${session.user?.nom ?? ''}`.trim()}>
      {offline && <Banner kind="info">Hors réseau : données du dernier chargement. Vos actions partiront au retour du réseau.</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
      {rejected.map((r) => (
        <Banner kind="error" key={r.key}>
          Action refusée ({r.action.type}) : {r.lastError?.message}
          <button type="button" className="link" onClick={async () => (await dismissRejected(r.key), setRejected(await rejectedItems()))}>
            Vu
          </button>
        </Banner>
      ))}

      {isOperator && (
        <section className="tiles">
          <button type="button" className="tile" onClick={() => go({ name: 'receptions' })}>
            <span className="icon">📦</span>
            Réceptions attendues
          </button>
          <button type="button" className="tile" onClick={() => go({ name: 'transfer' })}>
            <span className="icon">↔</span>
            Déplacer un article
          </button>
        </section>
      )}

      <h2>Mes missions</h2>
      {!boot && !error && <p className="hint">Chargement…</p>}
      {boot && missions.length === 0 && <p className="hint">Aucune mission affectée.</p>}
      <ul className="list">
        {missions.map((m: MissionSummary) => (
          <li key={m.id}>
            <button type="button" className="row" onClick={() => go({ name: 'mission', id: m.id, type: m.type })}>
              <span className="row-main">
                <strong>{TYPE_LABEL[m.type] ?? m.type}</strong> · {m.numero}
                {m.adresse?.libelle && <small>{m.adresse.libelle}</small>}
              </span>
              <span className={`pill ${m.statut === 'EN_COURS' ? 'warn' : ''}`}>{m.statut === 'EN_COURS' ? 'En cours' : m.creneau ?? 'À faire'}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className="footer-actions">
        <button type="button" className="btn secondary" onClick={() => void reload()}>
          Actualiser
        </button>
        <button
          type="button"
          className="btn secondary"
          onClick={async () => {
            if (!(await canLogout())) {
              setError('Des actions sont encore en attente d’envoi : reconnectez-vous au réseau avant de vous déconnecter.');
              return;
            }
            await logout();
            onLogout();
          }}
        >
          Se déconnecter
        </button>
      </div>
    </Screen>
  );
}
