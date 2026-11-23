import { useCallback, useEffect, useRef, useState } from 'react';
import { api, del, get, openPdf, post } from '../lib/api';
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

interface Ambiance {
  statut: 'EN_COURS' | 'PRET' | 'ECHEC';
  source: 'IA' | 'MANUEL';
  url: string | null;
  erreur: string | null;
}
interface PackDetail {
  pieces: { piece: string | null; articles: unknown[]; ambiance: Ambiance | null }[];
  visuels: { ia: boolean; restantsCeMois: number | null };
}

/**
 * Visuels d'aménagement des pièces d'un pack : génération par IA (Pollinations ou Higgsfield) à partir des meubles, ou image ajoutée
 * (photo de l'appartement témoin). Ils figurent en tête de pièce sur la planche et dans l'Espace Client.
 */
function PackVisuals({ packId, canEdit }: { packId: string; canEdit: boolean }) {
  const [d, setD] = useState<PackDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const target = useRef<string | null>(null);
  const load = useCallback(
    () =>
      get<PackDetail>(`/bo/packs/${packId}`)
        .then(setD)
        .catch((e) => setError((e as Error).message)),
    [packId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const generating = !!d?.pieces.some((g) => g.ambiance?.statut === 'EN_COURS');
  useEffect(() => {
    if (!generating) return;
    const timer = setTimeout(() => void load(), 4000);
    return () => clearTimeout(timer);
  }, [generating, d, load]);

  const run = async (piece: string, f: () => Promise<unknown>) => {
    setBusy(piece);
    setError(null);
    try {
      await f();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (!d) return error ? <Banner kind="error">{error}</Banner> : <p className="hint">Chargement…</p>;
  const rooms = d.pieces.filter((g): g is typeof g & { piece: string } => g.piece !== null);
  const q = (piece: string) => `?piece=${encodeURIComponent(piece)}`;
  return (
    <div className="pack-visuals">
      <p className="hint">
        {d.visuels.ia
          ? `Génération par IA active · ${d.visuels.restantsCeMois ?? 0} visuel${(d.visuels.restantsCeMois ?? 0) > 1 ? 's' : ''} encore possible${(d.visuels.restantsCeMois ?? 0) > 1 ? 's' : ''} ce mois-ci pour ce client.`
          : 'Génération par IA inactive (VISUELS_IA=off sur le serveur). Vous pouvez ajouter une image à la main.'}
      </p>
      {error && <Banner kind="error">{error}</Banner>}
      {!rooms.length && <p className="hint">Placez d’abord les biens dans des pièces.</p>}
      <ul className="photo-manage">
        {rooms.map((g) => {
          const a = g.ambiance;
          return (
            <li key={g.piece}>
              <strong>{g.piece}</strong>
              {a?.statut === 'PRET' && a.url ? (
                <a href={a.url} target="_blank" rel="noreferrer">
                  <img src={a.url} alt={`Visuel : ${g.piece}`} />
                </a>
              ) : (
                <span className="muted small">{a?.statut === 'EN_COURS' ? 'Génération en cours…' : a?.statut === 'ECHEC' ? `Échec : ${a.erreur ?? 'erreur inconnue'}` : 'Pas de visuel'}</span>
              )}
              {a?.statut === 'PRET' && <span className="muted small">{a.source === 'IA' ? 'Généré par IA' : 'Image ajoutée'}</span>}
              {canEdit && a?.statut !== 'EN_COURS' && (
                <span className="row">
                  {d.visuels.ia && (
                    <button type="button" className="link" disabled={!!busy || !d.visuels.restantsCeMois} onClick={() => void run(g.piece, () => post(`/bo/packs/${packId}/ambiances/ia`, { piece: g.piece }))}>
                      {busy === g.piece ? '…' : 'Générer (IA)'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="link"
                    disabled={!!busy}
                    onClick={() => {
                      target.current = g.piece;
                      file.current?.click();
                    }}
                  >
                    Image
                  </button>
                  {a && (
                    <button type="button" className="link danger" disabled={!!busy} onClick={() => void run(g.piece, () => del(`/bo/packs/${packId}/ambiances${q(g.piece)}`))}>
                      Retirer
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <input
        ref={file}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          const piece = target.current;
          e.target.value = '';
          if (!f || !piece) return;
          if (f.size > 8 * 1024 * 1024) return setError('Image trop lourde (8 Mo au maximum)');
          void run(piece, () => api(`/bo/packs/${packId}/ambiances${q(piece)}`, { method: 'PUT', body: f, headers: { 'Content-Type': f.type || 'image/jpeg' } }));
        }}
      />
    </div>
  );
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
  const [visuals, setVisuals] = useState<string | null>(null);

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
              <button type="button" className="btn small" aria-expanded={visuals === p.id} onClick={() => setVisuals(visuals === p.id ? null : p.id)}>
                Visuels des pièces
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
            {visuals === p.id && <PackVisuals packId={p.id} canEdit={canEdit} />}
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
