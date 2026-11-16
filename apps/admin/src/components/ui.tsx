import type { ReactNode } from 'react';
import { href, type Route } from '../lib/router';
import type { Session } from '../lib/api';
import { ROLE } from '../lib/labels';

export function Shell({ session, route, onLogout, children }: { session: Session; route: Route; onLogout: () => void; children: ReactNode }) {
  const nav: { r: Route; label: string; active: boolean }[] = [
    { r: { name: 'demandes' }, label: 'Demandes', active: route.name === 'demandes' || route.name === 'demande' },
    { r: { name: 'planning' }, label: 'Planning', active: route.name === 'planning' },
    { r: { name: 'clients' }, label: 'Clients', active: route.name === 'clients' || route.name === 'client' || route.name === 'nouveau-client' },
    { r: { name: 'stock' }, label: 'Stock', active: route.name === 'stock' },
  ];
  return (
    <div className="app bo">
      <header className="site-header">
        <div className="wrap header-row">
          <a className="wordmark" href={href({ name: 'demandes' })}>
            jamystock <span className="wordmark-tag">back-office</span>
          </a>
          <nav className="main-nav" aria-label="Navigation principale">
            {nav.map((n) => (
              <a key={n.label} href={href(n.r)} aria-current={n.active ? 'page' : undefined}>
                {n.label}
              </a>
            ))}
          </nav>
          <div className="header-actions">
            <span className="who" title={session.user?.email}>
              {session.user?.nom} · {ROLE[session.user?.role ?? ''] ?? ''}
            </span>
            <button type="button" className="btn ghost small" onClick={onLogout}>
              Se déconnecter
            </button>
          </div>
        </div>
      </header>
      <main className="wrap page">{children}</main>
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

export function Urgent() {
  return <span className="urgent">Urgent</span>;
}

export function Thumb({ src, alt }: { src: string | null | undefined; alt: string }) {
  return src ? <img className="thumbimg" src={src} alt={alt} loading="lazy" /> : <span className="thumbimg empty" aria-hidden="true" />;
}

/** Ton de pastille selon le statut d'une demande : citron = à traiter par le dépôt. */
export function orderTone(statut: string): 'neutral' | 'lime' | 'dark' | 'alert' {
  if (statut === 'SOUMISE') return 'lime';
  if (['REFUSEE', 'ANNULEE', 'ECHEC_LIVRAISON', 'LIVREE_AVEC_RESERVES'].includes(statut)) return 'alert';
  if (['PLANIFIEE', 'EN_PREPARATION', 'PRETE', 'EN_LIVRAISON'].includes(statut)) return 'dark';
  return 'neutral';
}
