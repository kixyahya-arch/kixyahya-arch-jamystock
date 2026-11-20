import { useEffect, useState } from 'react';
import { getSession, onSessionChange, type Session } from './lib/api';
import { onRejected, startAutoSync } from './lib/outbox';
import type { Reception } from './lib/data';
import { Login } from './screens/Login';
import { Home } from './screens/Home';
import { ReceptionFlow, Receptions, Transfer } from './screens/Reception';
import { Picking } from './screens/Picking';
import { Delivery, Pickup } from './screens/Delivery';
import { PhotoRequest } from './screens/PhotoRequest';
import { Degroupage } from './screens/Degroupage';
import { Banner, Screen } from './components/ui';

export type Route =
  | { name: 'home' }
  | { name: 'receptions' }
  | { name: 'reception'; reception: Reception }
  | { name: 'transfer' }
  | { name: 'mission'; id: string; type: string };

export function App() {
  const [session, setSession] = useState<Session | null>(getSession());
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => onSessionChange(setSession), []);
  useEffect(() => (session ? startAutoSync() : undefined), [session]);
  // Une action refusée par le serveur doit se voir tout de suite, quel que soit l'écran (§7.5).
  useEffect(
    () =>
      onRejected((item, r) => {
        setToast(`Action refusée (${item.action.type}) : ${r.message}`);
      }),
    [],
  );

  if (!session) return <Login onLogged={(s) => (setSession(s), setRoute({ name: 'home' }))} />;

  const home = () => setRoute({ name: 'home' });
  const view = (() => {
    switch (route.name) {
      case 'home':
        return <Home session={session} go={setRoute} onLogout={() => setSession(null)} />;
      case 'receptions':
        return <Receptions onBack={home} open={(reception) => setRoute({ name: 'reception', reception })} />;
      case 'reception':
        return <ReceptionFlow reception={route.reception} onBack={() => setRoute({ name: 'receptions' })} />;
      case 'transfer':
        return <Transfer onBack={home} />;
      case 'mission':
        switch (route.type) {
          case 'PREPARATION':
            return <Picking missionId={route.id} onBack={home} />;
          case 'LIVRAISON':
          case 'RETRAIT':
            return <Delivery missionId={route.id} onBack={home} />;
          case 'COLLECTE':
            return <Pickup missionId={route.id} onBack={home} />;
          case 'PHOTO':
            return <PhotoRequest missionId={route.id} onBack={home} />;
          case 'DEGROUPAGE':
            return <Degroupage missionId={route.id} onBack={home} />;
          default:
            return (
              <Screen title="Mission" onBack={home}>
                <p className="hint">Ce type de mission ({route.type}) n’est pas encore pris en charge sur le terminal.</p>
              </Screen>
            );
        }
    }
  })();

  return (
    <>
      {toast && (
        <div className="toast" onClick={() => setToast(null)}>
          <Banner kind="error">{toast}</Banner>
        </div>
      )}
      {view}
    </>
  );
}
