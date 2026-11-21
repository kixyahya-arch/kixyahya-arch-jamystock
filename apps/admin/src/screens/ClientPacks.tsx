import { useCallback, useEffect, useState } from 'react';
import { del, get, openPdf, post } from '../lib/api';
import { Banner } from '../components/ui';

interface Pack {
  id: string;
  nom: string;
  projet: string | null;
  nbArticles: number;
  nbDisponibles: number;
  pieces?: number;
  description?: string | null;
}

/** « A-000123 ; Salon » ou « A-000123 Salon » : une étiquette par ligne, suivie de sa pièce si besoin. */
export function parseBiens(text: string): { qr: string; piece: string | null }[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^([^\s;,]+)[\s;,]*(.*)$/.exec(l)!;
      return { qr: m[1]!, piece: m[2]?.trim() || null };
    });
}

/**
 * Packs d'un client (compte rendu Adam) : ensembles de meubles d'un logement ou d'un site, composés au Back-Office
 * à partir des étiquettes scannées. Le client les retrouve dans « Mes packs ».
 */
export function ClientPacks({ clientId, projets, canEdit }: { clientId: string; projets: { id: string; nom: string }[]; canEdit: boolean }) {
  const [items, setItems] = useState<Pack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [nom, setNom] = useState('');
  const [projetId, setProjetId] = useState('');
  const [biens, setBiens] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    get<{ items: Pack[] }>(`/bo/clients/${clientId}/packs`)
      .then((r) => setItems(r.items))
      .catch((e) => setError((e as Error).message));
  }, [clientId]);
  useEffect(load, [load]);
  const lines = parseBiens(biens);

  return (
    <section className="panel">
      <h2>Packs</h2>
      <p className="hint">Les meubles d’un logement ou d’un site, pièce par pièce. Le client les voit dans « Mes packs », les fait livrer en un clic et en tire une planche d’aménagement.</p>
      {error && <Banner kind="error">{error}</Banner>}
      {notice && <Banner kind="ok">{notice}</Banner>}
      {items?.length === 0 && <p className="hint">Aucun pack pour ce client.</p>}
      <ul className="plain">
        {items?.map((p) => (
          <li key={p.id}>
            <strong>{p.nom}</strong>
            <span className="muted">
              {p.projet ?? 'tous sites'} · {p.nbArticles} bien{p.nbArticles > 1 ? 's' : ''}
              {p.pieces ? ` · ${p.pieces} pièce${p.pieces > 1 ? 's' : ''}` : ''}
              {p.nbDisponibles < p.nbArticles ? ` · ${p.nbDisponibles} disponible${p.nbDisponibles > 1 ? 's' : ''}` : ''}
            </span>
            <span className="row">
              <button type="button" className="btn small" onClick={() => void openPdf(`/bo/packs/${p.id}/planche.pdf`, `planche-${p.nom}.pdf`).catch((e) => setError((e as Error).message))}>
                Planche (PDF)
              </button>
              {canEdit && (
                <button
                  type="button"
                  className="link"
                  onClick={async () => {
                    if (!window.confirm(`Supprimer le pack « ${p.nom} » ? Les biens restent en stock.`)) return;
                    try {
                      await del(`/bo/packs/${p.id}`);
                      load();
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Supprimer
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {canEdit &&
        (open ? (
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                const r = await post<{ nom: string; nbArticles: number }>(`/bo/clients/${clientId}/packs`, { nom: nom.trim(), ...(projetId ? { projetId } : {}), biens: lines });
                setNotice(`Pack « ${r.nom} » créé avec ${r.nbArticles} bien${r.nbArticles > 1 ? 's' : ''}.`);
                setNom('');
                setBiens('');
                setOpen(false);
                load();
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Nom du pack
              <input value={nom} onChange={(e) => setNom(e.target.value)} maxLength={80} required placeholder="Ex. Appartement témoin T3" />
            </label>
            {projets.length > 0 && (
              <label>
                Site (facultatif)
                <select value={projetId} onChange={(e) => setProjetId(e.target.value)}>
                  <option value="">Tous les biens du client</option>
                  {projets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.nom}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Étiquettes, une par ligne, suivies de la pièce
              <textarea rows={6} className="mono" value={biens} onChange={(e) => setBiens(e.target.value)} placeholder={'A-000123 ; Salon\nA-000124 ; Chambre 1\nA-000125'} required />
            </label>
            {lines.length > 0 && <p className="hint">{lines.length} bien{lines.length > 1 ? 's' : ''} à rattacher.</p>}
            <span className="row">
              <button type="submit" className="btn primary small" disabled={busy || !nom.trim() || !lines.length}>
                {busy ? '…' : 'Créer le pack'}
              </button>
              <button type="button" className="btn small" onClick={() => setOpen(false)}>
                Annuler
              </button>
            </span>
          </form>
        ) : (
          <button type="button" className="btn small" onClick={() => setOpen(true)}>
            Nouveau pack
          </button>
        ))}
    </section>
  );
}
