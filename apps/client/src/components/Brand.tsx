import { useId } from 'react';

/**
 * Marque JAMYSTOCK (charte graphique, docs/charte-graphique.md) : la goutte de JAMYS devient repère de carte,
 * le colis remplace la coche. Trait blanc à 7 % du symbole, reflet en haut à gauche, dégradé 135° Azur → Vert frais.
 * Couleur sur fond clair, blanc sur fond foncé, monochrome (encre) quand la couleur n'est pas possible.
 */
export type BrandVariant = 'couleur' | 'blanc' | 'mono';

const PIN = 'M24 64C22 60 18.6 46.4 12.64 43A23 23 0 1 1 35.36 43C29.4 46.4 26 60 24 64Z';
const CUBE = 'M24 9.8 35.8 16.3V29.3L24 35.8 12.2 29.3V16.3Z';
const CUBE_FACES = 'M12.2 16.3 24 22.8 35.8 16.3M24 22.8V35.8';

export function BrandSymbol({ variant = 'couleur', size = 32, title }: { variant?: BrandVariant; size?: number; title?: string }) {
  const id = useId().replace(/:/g, '');
  const pin = variant === 'couleur' ? `url(#g${id})` : variant === 'blanc' ? '#ffffff' : '#0a2a43';
  const cube = variant === 'blanc' ? '#0a2a43' : '#ffffff';
  return (
    <svg className="brand-symbol" viewBox="0 0 48 64" width={(size * 48) / 64} height={size} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      {variant === 'couleur' && (
        <defs>
          <linearGradient id={`g${id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#0ea5e9" />
            <stop offset="1" stopColor="#16c47f" />
          </linearGradient>
        </defs>
      )}
      <path d={PIN} fill={pin} />
      {variant === 'couleur' && <circle cx="13.6" cy="14.4" r="9.2" fill="#ffffff" opacity="0.18" />}
      <g fill="none" stroke={cube} strokeWidth="3.4" strokeLinejoin="round" strokeLinecap="round">
        <path d={CUBE} />
        <path d={CUBE_FACES} />
      </g>
    </svg>
  );
}

/** Logo complet (symbole + « JAMYSTOCK » + signature), ou réduit selon la place (marque responsive A à D). */
export function BrandLogo({
  variant = 'couleur',
  size = 32,
  tagline = true,
  suffix,
}: {
  variant?: BrandVariant;
  size?: number;
  tagline?: boolean;
  suffix?: string;
}) {
  return (
    <span className={`brand-logo brand-${variant}`} style={{ fontSize: size }}>
      <BrandSymbol variant={variant === 'couleur' ? 'couleur' : variant} size={size} />
      <span className="brand-text">
        <span className="brand-name">
          JAMYSTOCK{suffix && <span className="brand-suffix"> {suffix}</span>}
        </span>
        {tagline && <span className="brand-tagline">Stockage &amp; logistique</span>}
      </span>
    </span>
  );
}
