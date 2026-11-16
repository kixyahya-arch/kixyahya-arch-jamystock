import { useState } from 'react';
import { post } from '../lib/api';
import type { Mission, Resource, Vehicle } from '../lib/types';
import { roleFor } from '../lib/labels';

/**
 * FLX-03 : affecter une mission à une personne (chauffeur pour le transport, opérateur sinon) et, pour le transport,
 * à un véhicule. Le serveur contrôle la capacité (m³, kg) et renvoie des alertes sans bloquer.
 */
export function AssignForm({
  mission,
  ressources,
  vehicules,
  onDone,
}: {
  mission: Mission;
  ressources: Resource[];
  vehicules: Vehicle[];
  onDone: (warnings: string[]) => void;
}) {
  const role = roleFor(mission.type);
  const people = ressources.filter((r) => r.role === role);
  const transport = role === 'DRIVER';
  const [who, setWho] = useState(mission.assigneA ?? '');
  const [veh, setVeh] = useState(mission.vehiculeId ?? suggested(mission, vehicules) ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="assign"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!who) return;
        setBusy(true);
        setError(null);
        try {
          const r = await post<{ warnings: string[] }>(`/missions/${mission.id}/assign`, { assigneA: who, ...(transport && veh ? { vehiculeId: veh } : {}) });
          onDone(r.warnings ?? []);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <select aria-label={transport ? 'Chauffeur' : 'Opérateur'} value={who} onChange={(e) => setWho(e.target.value)} required>
        <option value="">{transport ? 'Choisir un chauffeur' : 'Choisir un opérateur'}</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.nom}
          </option>
        ))}
      </select>
      {transport && (
        <select aria-label="Véhicule" value={veh} onChange={(e) => setVeh(e.target.value)}>
          <option value="">Sans véhicule</option>
          {vehicules.map((v) => (
            <option key={v.id} value={v.id}>
              {v.immatriculation} · {v.volumeM3} m³
            </option>
          ))}
        </select>
      )}
      <button className="btn small" disabled={busy || !who}>
        {mission.assigneA ? 'Réaffecter' : 'Affecter'}
      </button>
      {error && <span className="form-error">{error}</span>}
    </form>
  );
}

/** Le plus petit véhicule qui contient le volume de la demande. */
function suggested(m: Mission, vehicules: Vehicle[]): string | undefined {
  const vol = m.volumeM3 ?? 0;
  return vehicules.find((v) => v.volumeM3 >= vol)?.id;
}
