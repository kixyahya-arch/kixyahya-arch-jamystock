import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ApiError, publicGet } from '../lib/api';
import { Banner } from '../components/ui';
import { BrandLogo } from '../components/Brand';

interface Suivi {
  numero: string | null;
  type: 'LIVRAISON' | 'COLLECTE';
  etape: 'PREVUE' | 'EN_ROUTE' | 'ARRIVE' | 'TERMINEE' | 'ANNULEE';
  chauffeur: string | null;
  eta: string | null;
  arretsAvant: number;
  creneau: string | null;
  datePrevue: string | null;
  enRouteLe: string | null;
  arriveLe: string | null;
  termineLe: string | null;
  position: { lat: number; lng: number; at: string; fraiche: boolean } | null;
  destination: { lat: number; lng: number } | null;
  adresse: string | null;
  expireLe: string;
  rafraichirDansS: number;
  tuiles: string;
}

const heure = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).replace(':', ' h ') : '');
const jour = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Paris' }) : '');
const STEPS: { key: Suivi['etape']; label: (s: Suivi) => string }[] = [
  { key: 'PREVUE', label: () => 'Prévue' },
  { key: 'EN_ROUTE', label: () => 'En route' },
  { key: 'ARRIVE', label: () => 'Sur place' },
  { key: 'TERMINEE', label: (s) => (s.type === 'COLLECTE' ? 'Biens enlevés' : 'Livrée') },
];

/**
 * SUI-02 : page de suivi ouverte depuis l'e-mail ou le SMS, sans connexion (lien valable 48 h).
 * Rafraîchie toutes les 60 s : position du chauffeur pendant le trajet et heure d'arrivée recalculée.
 */
export function Tracking({ token }: { token: string }) {
  const [s, setS] = useState<Suivi | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const r = await publicGet<Suivi>(`/public/suivi/${encodeURIComponent(token)}`);
        if (stop) return;
        setS(r);
        setError(null);
        setUpdated(new Date());
        if (r.etape !== 'TERMINEE' && r.etape !== 'ANNULEE') timer = setTimeout(load, r.rafraichirDansS * 1000);
      } catch (e) {
        if (stop) return;
        setError({ code: e instanceof ApiError ? e.code : 'RESEAU', message: (e as Error).message });
        // réseau coupé : on réessaie ; lien invalide ou expiré : on s'arrête
        if (!(e instanceof ApiError)) timer = setTimeout(load, 60_000);
      }
    };
    void load();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [token]);

  const idx = s ? STEPS.findIndex((x) => x.key === s.etape) : -1;
  return (
    <div className="tracking">
      <header className="tracking-head">
        <BrandLogo size={40} tagline={false} />
        <span>Suivi {s?.type === 'COLLECTE' ? 'de collecte' : 'de livraison'}</span>
      </header>
      {error && !s ? (
        <div className="tracking-body">
          <Banner kind={error.code === 'LIEN_EXPIRE' ? 'info' : 'error'}>
            {error.code === 'LIEN_EXPIRE'
              ? 'Ce lien de suivi a expiré (il reste valable 48 heures). Retrouvez votre commande dans votre Espace Client.'
              : error.code === 'LIEN_INVALIDE'
                ? 'Ce lien de suivi n’est pas valide. Vérifiez qu’il a été copié en entier.'
                : error.message}
          </Banner>
          <a className="btn primary" href="#/">
            Aller à mon Espace Client
          </a>
        </div>
      ) : !s ? (
        <p className="hint tracking-body">Chargement du suivi…</p>
      ) : (
        <div className="tracking-body">
          <section className="tracking-hero" aria-live="polite">
            <span className="eyebrow">
              — {s.type === 'COLLECTE' ? 'Collecte' : 'Livraison'} <span className="mono">{s.numero}</span>
            </span>
            {s.etape === 'EN_ROUTE' ? (
              <>
                <h1>{s.eta ? <>Arrivée vers {heure(s.eta)}</> : 'Le chauffeur est en route'}</h1>
                <p>
                  {s.chauffeur ? `${s.chauffeur} est parti` : 'Le chauffeur est parti'} à {heure(s.enRouteLe)}
                  {s.arretsAvant > 0 ? `, ${s.arretsAvant} arrêt${s.arretsAvant > 1 ? 's' : ''} avant vous` : ', vous êtes le prochain arrêt'}.
                </p>
              </>
            ) : s.etape === 'ARRIVE' ? (
              <>
                <h1>Le chauffeur est arrivé</h1>
                <p>Arrivé à {heure(s.arriveLe)}. Il vous attend à l’adresse indiquée.</p>
              </>
            ) : s.etape === 'TERMINEE' ? (
              <>
                <h1>{s.type === 'COLLECTE' ? 'Biens enlevés' : 'Livraison terminée'}</h1>
                <p>Terminé le {jour(s.termineLe)} à {heure(s.termineLe)}. Le bon signé est dans votre Espace Client.</p>
              </>
            ) : s.etape === 'ANNULEE' ? (
              <h1>Ce passage a été annulé</h1>
            ) : (
              <>
                <h1>Prévue {jour(s.datePrevue)}</h1>
                <p>{s.creneau ? `Créneau ${s.creneau}. ` : ''}Vous serez prévenu au départ du chauffeur.</p>
              </>
            )}
            {s.adresse && <p className="muted">{s.adresse}</p>}
          </section>

          {s.etape !== 'ANNULEE' && (
            <ol className="tracking-steps" aria-label="Étapes">
              {STEPS.map((x, i) => (
                <li key={x.key} className={i < idx ? 'done' : i === idx ? 'current' : ''} aria-current={i === idx ? 'step' : undefined}>
                  {x.label(s)}
                </li>
              ))}
            </ol>
          )}

          {(s.position || s.destination) && s.etape !== 'TERMINEE' && <TrackMap s={s} />}
          {s.etape === 'EN_ROUTE' && !s.position && <p className="hint">La position du véhicule apparaîtra dès qu’elle sera reçue.</p>}
          {s.position && !s.position.fraiche && <p className="hint">Dernière position reçue à {heure(s.position.at)} (réseau faible) : l’heure d’arrivée reste une estimation.</p>}

          <p className="muted small tracking-foot">
            {updated ? `Mis à jour à ${updated.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Europe/Paris' })}` : ''}
            {s.etape === 'EN_ROUTE' ? ' · actualisé chaque minute' : ''} · lien valable jusqu’au {jour(s.expireLe)} {heure(s.expireLe)}
          </p>
        </div>
      )}
    </div>
  );
}

function TrackMap({ s }: { s: Suivi }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { scrollWheelZoom: false }).setView([48.86, 2.35], 12);
    L.tileLayer(s.tuiles, { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => {
      map.current?.stop();
      map.current?.remove();
      map.current = null;
    };
  }, [s.tuiles]);
  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const pts: [number, number][] = [];
    if (s.destination) {
      L.marker([s.destination.lat, s.destination.lng], { icon: L.divIcon({ className: 'map-pin pin-home', html: '<span>Vous</span>' }), keyboard: false }).addTo(g);
      pts.push([s.destination.lat, s.destination.lng]);
    }
    if (s.position) {
      L.marker([s.position.lat, s.position.lng], { icon: L.divIcon({ className: `map-pin pin-truck${s.position.fraiche ? '' : ' stale'}`, html: '<span>Camion</span>' }), keyboard: false }).addTo(g);
      pts.push([s.position.lat, s.position.lng]);
    }
    if (pts.length > 1) m.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 15, animate: false });
    else if (pts.length) m.setView(pts[0]!, 14, { animate: false });
  }, [s.position, s.destination]);
  return <div ref={el} className="tracking-map" role="img" aria-label={s.position ? 'Position du véhicule et adresse de destination' : 'Adresse de destination'} />;
}
