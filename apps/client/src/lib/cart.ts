import { useSyncExternalStore } from 'react';
import { del, get, post } from './api';
import type { Cart } from './types';

/**
 * Paniers du client. Côté API, un panier est propre à un projet (un B2B commande projet par projet) ;
 * l'écran les présente ensemble, rangés par projet. La clé '' désigne le panier sans projet.
 */
type State = { carts: Record<string, Cart>; loaded: boolean };
let state: State = { carts: {}, loaded: false };
const listeners = new Set<() => void>();
const set = (s: State) => {
  state = s;
  listeners.forEach((l) => l());
};

const q = (projetId: string) => (projetId ? `?projetId=${projetId}` : '');

export async function loadCarts(projetIds: string[], includeNoProject: boolean): Promise<void> {
  const keys = [...(includeNoProject ? [''] : []), ...projetIds];
  const carts: Record<string, Cart> = {};
  await Promise.all(keys.map(async (k) => (carts[k] = await get<Cart>(`/cart${q(k)}`))));
  set({ carts, loaded: true });
}

async function reload(projetId: string) {
  const c = await get<Cart>(`/cart${q(projetId)}`);
  set({ ...state, carts: { ...state.carts, [projetId]: c } });
}

export async function addToCart(articleId: string, projetId: string | null) {
  await post('/cart/items', { articleIds: [articleId], ...(projetId ? { projetId } : {}) });
  await reload(projetId ?? '');
}

export async function removeFromCart(articleId: string, projetId: string | null) {
  await del(`/cart/items/${articleId}${q(projetId ?? '')}`);
  await reload(projetId ?? '');
}

export const refreshCart = (projetId: string | null) => reload(projetId ?? '');

export function useCarts() {
  const s = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  );
  const inCart = new Set(Object.values(s.carts).flatMap((c) => c.lignes.map((l) => l.articleId!)));
  const count = Object.values(s.carts).reduce((n, c) => n + c.nbArticles, 0);
  return { ...s, inCart, count };
}
