import { useEffect, useState } from 'react';
import { get, getSession, logout, onSessionChange, startSupport, type Session } from './lib/api';
import { loadCarts } from './lib/cart';
import { useRoute } from './lib/router';
import type { Ctx } from './lib/types';
import { Login } from './screens/Login';
import { Inventory } from './screens/Inventory';
import { ArticleView } from './screens/ArticleView';
import { CartView } from './screens/CartView';
import { OrderView, Orders } from './screens/Orders';
import { Collection } from './screens/Collection';
import { Documents } from './screens/Documents';
import { Invitation } from './screens/Invitation';
import { Users } from './screens/Users';
import { Tracking } from './screens/Tracking';
import { Account } from './screens/Account';
import { Banner, Shell } from './components/ui';

const CLIENT_ROLES = ['B2B_ADMIN', 'B2B_USER', 'B2C'];

export function App() {
  const [session, setSession] = useState<Session | null>(getSession());
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [error, setError] = useState<string | null>(null);
  const route = useRoute();
  const role = session?.user?.role ?? '';

  useEffect(() => onSessionChange(setSession), []);
  useEffect(() => {
    setCtx(null);
    if (!session || !CLIENT_ROLES.includes(role)) return;
    get<Ctx>('/me/context')
      .then((c) => {
        setCtx(c);
        return loadCarts(
          c.projets.map((p) => p.id),
          role !== 'B2B_USER',
        );
      })
      .catch((e) => setError((e as Error).message));
  }, [session, role]);

  // ADM-03 : le lien d'invitation s'ouvre sans session (et remplace une session ouverte sur cet appareil)
  if (route.name === 'invitation') return <Invitation token={route.token} onLogged={setSession} />;
  // CLI-02 : lien « voir son espace » ouvert depuis le Back-Office
  if (route.name === 'support') return <SupportStart token={route.token} onLogged={setSession} />;
  // SUI-02 : suivi du chauffeur, ouvert sans compte depuis l'e-mail ou le SMS
  if (route.name === 'suivi') return <Tracking token={route.token} />;
  if (!session) return <Login onLogged={setSession} />;
  const onLogout = () =>
    void logout().then(() => {
      setSession(null);
      // l'onglet de support a été ouvert par le Back-Office : on le referme si le navigateur l'accepte
      if (session.support) window.close();
    });
  if (!CLIENT_ROLES.includes(role)) {
    return (
      <div className="login">
        <Banner kind="info">Cet espace est réservé aux clients. Le personnel JAMYSTOCK utilise le Back-Office et l’app terrain.</Banner>
        <button type="button" className="btn primary big" onClick={onLogout}>
          Changer de compte
        </button>
      </div>
    );
  }

  return (
    <Shell session={session} route={route} onLogout={onLogout}>
      {error && <Banner kind="error">{error}</Banner>}
      {!ctx ? (
        !error && <p className="hint">Chargement…</p>
      ) : route.name === 'article' ? (
        <ArticleView id={route.id} canOrder />
      ) : route.name === 'panier' ? (
        <CartView ctx={ctx} role={role} />
      ) : route.name === 'commandes' ? (
        <Orders ctx={ctx} />
      ) : route.name === 'commande' ? (
        <OrderView id={route.id} role={role} />
      ) : route.name === 'collecte' ? (
        <Collection ctx={ctx} role={role} />
      ) : route.name === 'documents' ? (
        <Documents key={window.location.hash} ctx={ctx} role={role} />
      ) : route.name === 'compte' ? (
        <Account key={window.location.hash} session={session} />
      ) : route.name === 'utilisateurs' && role === 'B2B_ADMIN' ? (
        <Users />
      ) : (
        <Inventory ctx={ctx} canOrder />
      )}
    </Shell>
  );
}

function SupportStart({ token, onLogged }: { token: string; onLogged: (s: Session) => void }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    startSupport(token)
      .then((s) => {
        // le jeton ne reste ni dans la barre d'adresse ni dans l'historique
        window.history.replaceState(null, '', `${window.location.pathname}#/`);
        window.dispatchEvent(new HashChangeEvent('hashchange'));
        onLogged(s);
      })
      .catch((e) => setError((e as Error).message));
  }, [token, onLogged]);
  return (
    <div className="login">
      {error ? <Banner kind="error">Lien de support expiré ou invalide : rouvrez-le depuis le Back-Office. ({error})</Banner> : <p className="hint">Ouverture de l’espace client…</p>}
    </div>
  );
}
