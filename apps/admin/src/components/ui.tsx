import type { ReactNode } from 'react';
import { href, type Route } from '../lib/router';
import type { Session } from '../lib/api';
import { ROLE } from '../lib/labels';
import { BrandLogo } from './Brand';

export function Shell({ session, route, onLogout, children }: { session: Session; route: Route; onLogout: () => void; children: ReactNode }) {
  const nav: { r: Route; label: string; active: boolean }[] = [
    ...(session.user?.role === 'SUPER_ADMIN' ? [{ r: { name: 'pilotage' } as Route, label: 'Pilotage', active: route.name === 'pilotage' }] : []),
    { r: { name: 'demandes' }, label: 'Demandes', active: route.name === 'demandes' || route.name === 'demande' },
    { r: { name: 'planning' }, label: 'Planning', active: ['planning', 'tournees', 'carte'].includes(route.name) },
    { r: { name: 'clients' }, label: 'Clients', active: route.name === 'clients' || route.name === 'client' || route.name === 'nouveau-client' || route.name === 'reprise' },
    ...(session.user?.role === 'SUPER_ADMIN'
      ? [{ r: { name: 'depots' } as Route, label: 'Dépôts', active: ['depots', 'depot', 'plan-depot', 'inventaires', 'inventaire'].includes(route.name) }]
      : []),
    { r: { name: 'stock' }, label: 'Stock', active: route.name === 'stock' || route.name === 'article' },
    { r: { name: 'litiges' }, label: 'Litiges', active: route.name === 'litiges' },
    // tarifs et montants : Super Admin seulement (le Dispatcher n'y a pas accès, §2.2)
    ...(session.user?.role === 'SUPER_ADMIN'
      ? [
          { r: { name: 'facturation' } as Route, label: 'Facturation', active: ['facturation', 'facture', 'tarifs', 'surfaces'].includes(route.name) },
          { r: { name: 'emails' } as Route, label: 'E-mails', active: ['emails', 'modeles-email', 'modele-email'].includes(route.name) },
        ]
      : []),
  ];
  return (
    <div className="app bo">
      <header className="site-header">
        <div className="wrap header-row">
          <a className="wordmark" href={href({ name: 'demandes' })} aria-label="JAMYSTOCK Back-Office, accueil">
            <BrandLogo variant="blanc" size={36} tagline={false} />
            <span className="wordmark-tag">back-office</span>
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

/** Couleurs fonctionnelles de la charte : accent = en préparation / à traiter, route = en cours de livraison,
 * ok = livré, dark = stocké, alert = anomalie (rouge, jamais décoratif), neutral = annulé / archivé. */
export type Tone = 'neutral' | 'accent' | 'route' | 'ok' | 'dark' | 'alert';

export function StatusPill({ label, tone = 'neutral' }: { label: string; tone?: Tone }) {
  return <span className={`status ${tone}`}>{label}</span>;
}

export function Urgent() {
  return <span className="urgent">Urgent</span>;
}

export function Thumb({ src, alt }: { src: string | null | undefined; alt: string }) {
  return src ? <img className="thumbimg" src={src} alt={alt} loading="lazy" /> : <span className="thumbimg empty" aria-hidden="true" />;
}

/** Ton de pastille selon le statut d'une demande (couleurs fonctionnelles de la charte). */
export function orderTone(statut: string): Tone {
  if (['REFUSEE', 'ECHEC_LIVRAISON', 'LIVREE_AVEC_RESERVES'].includes(statut)) return 'alert';
  if (statut === 'EN_LIVRAISON') return 'route';
  if (['SOUMISE', 'EN_ATTENTE_VALIDATION', 'PLANIFIEE', 'EN_PREPARATION', 'PRETE'].includes(statut)) return 'accent';
  if (['LIVREE', 'RETIREE', 'COLLECTEE', 'CLOTUREE'].includes(statut)) return 'ok';
  if (statut === 'STOCKEE') return 'dark';
  return 'neutral';
}

export function Tile({ n, label, href: link, accent, alert, onClick }: { n: number | string; label: string; href?: string; accent?: boolean; alert?: boolean; onClick?: () => void }) {
  const cls = `tile${accent ? ' accent' : ''}${alert ? ' alert' : ''}`;
  const body = (
    <>
      <strong>{n}</strong>
      <span>{label}</span>
    </>
  );
  if (link) return <a className={cls} href={link}>{body}</a>;
  if (onClick) return <button type="button" className={cls} onClick={onClick}>{body}</button>;
  return <div className={cls}>{body}</div>;
}

/** Onglets du planning : par ressource, par tournée, carte des chauffeurs. */
export function PlanningTabs({ active, date }: { active: 'planning' | 'tournees' | 'carte'; date?: string }) {
  return (
    <nav className="subnav" aria-label="Planning">
      <a href={href({ name: 'planning', date })} aria-current={active === 'planning' ? 'page' : undefined}>
        Par ressource
      </a>
      <a href={href({ name: 'tournees', date })} aria-current={active === 'tournees' ? 'page' : undefined}>
        Tournées
      </a>
      <a href={href({ name: 'carte' })} aria-current={active === 'carte' ? 'page' : undefined}>
        Carte des chauffeurs
      </a>
    </nav>
  );
}

export function EmailTabs({ active }: { active: 'emails' | 'modeles' }) {
  return (
    <nav className="subnav" aria-label="E-mails">
      <a href={href({ name: 'emails' })} aria-current={active === 'emails' ? 'page' : undefined}>
        Envois
      </a>
      <a href={href({ name: 'modeles-email' })} aria-current={active === 'modeles' ? 'page' : undefined}>
        Modèles
      </a>
    </nav>
  );
}
