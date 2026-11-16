import { useEffect, useState } from 'react';

/** Routage par ancre (#/…) : liens partageables, aucun réglage serveur nécessaire. */
export type Route =
  | { name: 'inventaire' }
  | { name: 'article'; id: string }
  | { name: 'panier' }
  | { name: 'commandes' }
  | { name: 'commande'; id: string }
  | { name: 'collecte' };

export function parse(hash: string): Route {
  const [, a, b] = hash.replace(/^#/, '').split('/');
  if (a === 'article' && b) return { name: 'article', id: b };
  if (a === 'commandes' && b) return { name: 'commande', id: b };
  if (a === 'commandes') return { name: 'commandes' };
  if (a === 'panier') return { name: 'panier' };
  if (a === 'collecte') return { name: 'collecte' };
  return { name: 'inventaire' };
}

export function href(r: Route): string {
  switch (r.name) {
    case 'article':
      return `#/article/${r.id}`;
    case 'commande':
      return `#/commandes/${r.id}`;
    case 'inventaire':
      return '#/';
    default:
      return `#/${r.name}`;
  }
}

export const go = (r: Route) => {
  window.location.hash = href(r);
};

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(parse(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
