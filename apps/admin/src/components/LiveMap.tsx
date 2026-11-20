import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export interface MapPoint {
  id: string;
  lat: number;
  lng: number;
  kind: 'driver' | 'driver-stale' | 'stop' | 'stop-done' | 'depot';
  label: string;
  title?: string;
}

/**
 * Carte Leaflet (FLX-04, FLX-05) : chauffeurs, arrêts, dépôts, et le trajet d'une tournée.
 * Les marqueurs sont dessinés en HTML (pas d'images) ; le fond de carte vient de MAP_TILES_URL.
 */
export function LiveMap({ tiles, points, route, height = 460, label }: { tiles: string; points: MapPoint[]; route?: [number, number][]; height?: number; label: string }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const fitted = useRef('');

  useEffect(() => {
    if (!el.current || map.current) return;
    map.current = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([48.86, 2.35], 11);
    L.tileLayer(tiles, { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    return () => {
      map.current?.stop();
      map.current?.remove();
      map.current = null;
    };
  }, [tiles]);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    if (route && route.length > 1) L.polyline(route, { className: 'map-route', weight: 3, opacity: 0.8, dashArray: '6 6' }).addTo(g);
    for (const p of points) {
      const icon = L.divIcon({ className: `map-pin pin-${p.kind}`, html: `<span>${escapeHtml(p.label)}</span>`, iconSize: undefined });
      L.marker([p.lat, p.lng], { icon, title: p.title ?? p.label, keyboard: false }).addTo(g);
    }
    // recadrer quand l'ensemble des points change, pas à chaque rafraîchissement de position
    const key = points.map((p) => p.id).sort().join('|') + (route?.length ?? 0);
    if (key !== fitted.current && points.length) {
      fitted.current = key;
      const b = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]));
      m.fitBounds(b.pad(0.2), { maxZoom: 14, animate: false });
    }
  }, [points, route]);

  return <div ref={el} className="live-map" style={{ height }} role="img" aria-label={label} />;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
