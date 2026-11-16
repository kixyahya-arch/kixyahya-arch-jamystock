import { useEffect, useState } from 'react';

/** Routage par ancre (#/…) : liens partageables, aucun réglage serveur nécessaire. */
export type Route =
  | { name: 'demandes' }
  | { name: 'demande'; id: string }
  | { name: 'planning'; date?: string }
  | { name: 'clients' }
  | { name: 'client'; id: string }
  | { name: 'nouveau-client' }
  | { name: 'stock' };

export function parse(hash: string): Route {
  const [, a, b] = hash.replace(/^#/, '').split('/');
  if (a === 'demandes' && b) return { name: 'demande', id: b };
  if (a === 'planning') return b && /^\d{4}-\d{2}-\d{2}$/.test(b) ? { name: 'planning', date: b } : { name: 'planning' };
  if (a === 'clients' && b === 'nouveau') return { name: 'nouveau-client' };
  if (a === 'clients' && b) return { name: 'client', id: b };
  if (a === 'clients') return { name: 'clients' };
  if (a === 'stock') return { name: 'stock' };
  return { name: 'demandes' };
}

export function href(r: Route): string {
  switch (r.name) {
    case 'demande':
      return `#/demandes/${r.id}`;
    case 'planning':
      return r.date ? `#/planning/${r.date}` : '#/planning';
    case 'client':
      return `#/clients/${r.id}`;
    case 'nouveau-client':
      return '#/clients/nouveau';
    case 'demandes':
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
