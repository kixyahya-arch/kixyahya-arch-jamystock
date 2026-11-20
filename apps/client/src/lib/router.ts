import { useEffect, useState } from 'react';

/** Routage par ancre (#/…) : liens partageables, aucun réglage serveur nécessaire. */
export type Route =
  | { name: 'inventaire' }
  | { name: 'article'; id: string }
  | { name: 'panier' }
  | { name: 'commandes' }
  | { name: 'commande'; id: string }
  | { name: 'collecte' }
  | { name: 'documents' }
  | { name: 'compte' }
  | { name: 'utilisateurs' }
  | { name: 'invitation'; token: string }
  | { name: 'support'; token: string }
  | { name: 'suivi'; token: string };

export function parse(hash: string): Route {
  const [, a, b] = hash.replace(/^#/, '').split('?')[0]!.split('/');
  if (a === 'invitation' && b) return { name: 'invitation', token: b };
  if (a === 'support' && b) return { name: 'support', token: b };
  if (a === 'suivi' && b) return { name: 'suivi', token: b };
  if (a === 'compte') return { name: 'compte' };
  if (a === 'utilisateurs') return { name: 'utilisateurs' };
  if (a === 'article' && b) return { name: 'article', id: b };
  if (a === 'commandes' && b) return { name: 'commande', id: b };
  if (a === 'commandes') return { name: 'commandes' };
  if (a === 'panier') return { name: 'panier' };
  if (a === 'collecte') return { name: 'collecte' };
  if (a === 'documents') return { name: 'documents' };
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
    case 'invitation':
      return `#/invitation/${r.token}`;
    case 'support':
      return `#/support/${r.token}`;
    case 'suivi':
      return `#/suivi/${r.token}`;
    default:
      return `#/${r.name}`;
  }
}

/** Paramètre de l'ancre (#/compte?paiement=enregistre), utilisé au retour de Stripe. */
export function hashParam(name: string): string | null {
  const q = window.location.hash.split('?')[1];
  return q ? new URLSearchParams(q).get(name) : null;
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
