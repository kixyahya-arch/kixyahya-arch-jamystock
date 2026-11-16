import { useEffect, useState } from 'react';
import { get, getSession, logout, onSessionChange, type Session } from './lib/api';
import { loadCarts } from './lib/cart';
import { useRoute } from './lib/router';
import type { Ctx } from './lib/types';
import { Login } from './screens/Login';
import { Inventory } from './screens/Inventory';
import { ArticleView } from './screens/ArticleView';
import { CartView } from './screens/CartView';
import { OrderView, Orders } from './screens/Orders';
import { Collection } from './screens/Collection';
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

  if (!session) return <Login onLogged={setSession} />;
  const onLogout = () => void logout().then(() => setSession(null));
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
      ) : (
        <Inventory ctx={ctx} canOrder />
      )}
    </Shell>
  );
}
