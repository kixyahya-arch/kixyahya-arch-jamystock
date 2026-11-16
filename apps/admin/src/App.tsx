import { useEffect, useState } from 'react';
import { get, getSession, logout, onSessionChange, type Session } from './lib/api';
import { useRoute } from './lib/router';
import type { BoContext } from './lib/types';
import { Login } from './screens/Login';
import { Dashboard } from './screens/Dashboard';
import { OrderView } from './screens/OrderView';
import { PlanningView } from './screens/Planning';
import { ClientView, Clients, NewClient } from './screens/Clients';
import { Stock } from './screens/Stock';
import { InvoiceView, Invoices } from './screens/Billing';
import { Pricing, Surfaces } from './screens/Pricing';
import { Banner, Shell } from './components/ui';

/** Le Back-Office est réservé à l'encadrement du dépôt ; opérateurs et chauffeurs utilisent l'app terrain. */
const BO_ROLES = ['SUPER_ADMIN', 'DISPATCHER'];

export function App() {
  const [session, setSession] = useState<Session | null>(getSession());
  const [ctx, setCtx] = useState<BoContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const route = useRoute();
  const role = session?.user?.role ?? '';

  useEffect(() => onSessionChange(setSession), []);
  useEffect(() => {
    setCtx(null);
    setError(null);
    if (!session || !BO_ROLES.includes(role)) return;
    get<BoContext>('/bo/context')
      .then(setCtx)
      .catch((e) => setError((e as Error).message));
  }, [session, role]);

  if (!session) return <Login onLogged={setSession} />;
  const onLogout = () => void logout().then(() => setSession(null));
  if (!BO_ROLES.includes(role)) {
    return (
      <div className="login">
        <Banner kind="info">
          Le Back-Office est réservé au responsable d’exploitation et au dispatch. Les opérateurs et chauffeurs utilisent l’app terrain, les clients leur Espace Client.
        </Banner>
        <button type="button" className="btn primary big" onClick={onLogout}>
          Changer de compte
        </button>
      </div>
    );
  }

  const isAdmin = role === 'SUPER_ADMIN';
  return (
    <Shell session={session} route={route} onLogout={onLogout}>
      {error && <Banner kind="error">{error}</Banner>}
      {!ctx ? (
        !error && <p className="hint">Chargement…</p>
      ) : route.name === 'demande' ? (
        <OrderView id={route.id} />
      ) : route.name === 'planning' ? (
        <PlanningView date={route.date ?? ctx.today} />
      ) : route.name === 'clients' ? (
        <Clients canCreate={isAdmin} />
      ) : route.name === 'client' ? (
        <ClientView id={route.id} />
      ) : route.name === 'nouveau-client' ? (
        isAdmin ? <NewClient /> : <Banner kind="info">Seul le Super Admin ouvre des comptes clients.</Banner>
      ) : route.name === 'stock' ? (
        <Stock ctx={ctx} />
      ) : ['facturation', 'facture', 'tarifs', 'surfaces'].includes(route.name) && !isAdmin ? (
        <Banner kind="info">La facturation et les tarifs sont réservés au Super Admin.</Banner>
      ) : route.name === 'facturation' ? (
        <Invoices ctx={ctx} />
      ) : route.name === 'facture' ? (
        <InvoiceView id={route.id} />
      ) : route.name === 'tarifs' ? (
        <Pricing ctx={ctx} />
      ) : route.name === 'surfaces' ? (
        <Surfaces ctx={ctx} client={route.client} />
      ) : (
        <Dashboard ctx={ctx} />
      )}
    </Shell>
  );
}
