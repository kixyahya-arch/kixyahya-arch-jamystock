import { useEffect, useState, type ReactNode } from 'react';
import { flush, subscribe, type OutboxState } from '../lib/outbox';
import { BrandSymbol } from './Brand';

/** Pastille « N actions en attente d'envoi » (§7.5), visible en permanence. */
export function SyncBadge() {
  const [s, setS] = useState<OutboxState | null>(null);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => subscribe(setS), []);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (!s) return null;
  const waiting = s.pending + s.photos;
  const cls = !online ? 'offline' : waiting ? 'waiting' : 'synced';
  const text = waiting
    ? `${s.pending ? `${s.pending} action${s.pending > 1 ? 's' : ''}` : ''}${s.pending && s.photos ? ' · ' : ''}${s.photos ? `${s.photos} photo${s.photos > 1 ? 's' : ''}` : ''} en attente`
    : 'Tout est envoyé';
  return (
    <button type="button" className={`sync-badge ${cls}`} onClick={() => void flush()} aria-live="polite">
      <span className="dot" />
      {online ? '' : 'Hors réseau · '}
      {s.syncing ? 'Envoi…' : text}
      {s.rejected > 0 && <span className="rejected">{s.rejected} refusée{s.rejected > 1 ? 's' : ''}</span>}
    </button>
  );
}

export function Screen({ title, onBack, children, actions }: { title: string; onBack?: () => void; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="screen">
      <header className="topbar">
        {onBack ? (
          <button type="button" className="back" onClick={onBack} aria-label="Retour">
            ‹
          </button>
        ) : (
          <span className="brand" title="JAMYSTOCK">
            <BrandSymbol variant="blanc" size={34} title="JAMYSTOCK" />
          </span>
        )}
        <h1>{title}</h1>
        <SyncBadge />
      </header>
      <main className="content">{children}</main>
      {actions && <footer className="actions">{actions}</footer>}
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

export function Choice<T extends string>({ value, options, onChange, label }: { value: T | null; options: { value: T; label: string; icon?: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <fieldset className="choice">
      <legend>{label}</legend>
      <div className="choice-grid">
        {options.map((o) => (
          <button type="button" key={o.value} className={value === o.value ? 'selected' : ''} aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
            {o.icon && <span className="icon">{o.icon}</span>}
            {o.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
