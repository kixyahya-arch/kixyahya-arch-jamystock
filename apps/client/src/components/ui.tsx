import type { ReactNode } from 'react';
import { href, type Route } from '../lib/router';
import { useCarts } from '../lib/cart';
import type { Session } from '../lib/api';

export function Shell({ session, route, onLogout, children }: { session: Session; route: Route; onLogout: () => void; children: ReactNode }) {
  const { count } = useCarts();
  const nav: { r: Route; label: string; active: boolean }[] = [
    { r: { name: 'inventaire' }, label: 'Mon stock', active: route.name === 'inventaire' || route.name === 'article' },
    { r: { name: 'commandes' }, label: 'Commandes', active: route.name === 'commandes' || route.name === 'commande' },
    { r: { name: 'collecte' }, label: 'Demander une collecte', active: route.name === 'collecte' },
    { r: { name: 'documents' }, label: 'Documents', active: route.name === 'documents' },
    ...(session.user?.role === 'B2B_ADMIN' ? [{ r: { name: 'utilisateurs' } as Route, label: 'Utilisateurs', active: route.name === 'utilisateurs' }] : []),
  ];
  return (
    <div className="app">
      <header className="site-header">
        <div className="wrap header-row">
          <a className="wordmark" href={href({ name: 'inventaire' })}>
            jamystock
          </a>
          <nav className="main-nav" aria-label="Navigation principale">
            {nav.map((n) => (
              <a key={n.label} href={href(n.r)} aria-current={n.active ? 'page' : undefined}>
                {n.label}
              </a>
            ))}
          </nav>
          <div className="header-actions">
            <a className="who" title={`${session.user?.email ?? ''} · Mon compte`} href={href({ name: 'compte' })} aria-current={route.name === 'compte' ? 'page' : undefined}>
              {session.user?.nom}
            </a>
            <button type="button" className="btn ghost small" onClick={onLogout}>
              Se déconnecter
            </button>
            <a className="btn primary small" href={href({ name: 'panier' })}>
              Panier{count > 0 && <span className="count">{count}</span>}
            </a>
          </div>
        </div>
      </header>
      <main className="wrap page">{children}</main>
      <footer className="site-footer">
        <div className="wrap">
          <div className="footer-cols">
            <div>
              <h4>Mon espace</h4>
              <a href={href({ name: 'inventaire' })}>Mon stock</a>
              <a href={href({ name: 'commandes' })}>Commandes</a>
              <a href={href({ name: 'collecte' })}>Collecte</a>
              <a href={href({ name: 'documents' })}>Documents</a>
              <a href={href({ name: 'compte' })}>Mon compte</a>
            </div>
            <div>
              <h4>JAMYSTOCK</h4>
              <p>Stockage tracé, objet par objet : chaque bien est photographié, étiqueté et localisé, et chaque mouvement est horodaté.</p>
            </div>
          </div>
          <div className="giant" aria-hidden="true">
            jamystock
          </div>
        </div>
      </footer>
    </div>
  );
}

export function Banner({ kind, children }: { kind: 'ok' | 'error' | 'info'; children: ReactNode }) {
  return (
    <div className={`banner ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Pills<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="pills" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function StatusPill({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'lime' | 'dark' | 'alert' }) {
  return <span className={`status ${tone}`}>{label}</span>;
}

export function Thumb({ src, alt, className = '' }: { src: string | null | undefined; alt: string; className?: string }) {
  return src ? <img className={`thumbimg ${className}`} src={src} alt={alt} loading="lazy" /> : <span className={`thumbimg empty ${className}`} aria-hidden="true" />;
}
