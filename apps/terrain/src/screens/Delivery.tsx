import { useEffect, useState } from 'react';
import { uuidv7, type ReserveInput } from '@jamystock/domain/browser';
import { Scanner } from '../components/Scanner';
import { PhotoCapture, type CapturedPhoto } from '../components/PhotoCapture';
import { SignaturePad } from '../components/SignaturePad';
import { Banner, Choice, Screen } from '../components/ui';
import { enqueue, enqueuePhoto } from '../lib/outbox';
import { markGet, markSet } from '../lib/db';
import { blFingerprint, currentPosition, pickupFingerprint } from '../lib/device';
import { loadMission, type MissionDetail, type MissionLine } from '../lib/data';

type Phase = 'route' | 'unload' | 'sign' | 'done';
interface LocalState {
  phase: Phase;
  departed: boolean;
  arrived: boolean;
  outcome: Record<string, 'LIVRE' | 'REFUSE'>;
  reserves: (ReserveInput & { photoUrls?: string[] })[];
  bl?: string;
  /** LIV-05 : BL « non signé, déposé » */
  depose?: boolean;
}
const INITIAL: LocalState = { phase: 'route', departed: false, arrived: false, outcome: {}, reserves: [] };

const RESERVE_TYPES = [
  { value: 'CASSE', label: 'Casse' },
  { value: 'RAYURE', label: 'Rayure' },
  { value: 'MANQUANT', label: 'Manquant' },
  { value: 'AUTRE', label: 'Autre' },
] as const;

/** §4.3 : livraison avec signature du BL, entièrement hors-ligne (LIV-01, LIV-03, LIV-04). */
export function Delivery({ missionId, onBack }: { missionId: string; onBack: () => void }) {
  const [m, setM] = useState<MissionDetail | undefined>();
  const [st, setSt] = useState<LocalState>(INITIAL);
  const [info, setInfo] = useState<string | null>(null);
  const [reserveFor, setReserveFor] = useState<MissionLine | null>(null);
  const key = `delivery:${missionId}`;

  useEffect(() => {
    void loadMission(missionId).then((r) => setM(r.data));
    void markGet<LocalState>(key, INITIAL).then(setSt);
  }, [missionId, key]);
  const save = async (next: LocalState) => {
    setSt(next);
    await markSet(key, next);
  };

  if (!m?.commande) return <Screen title="Livraison" onBack={onBack}>{<p className="hint">Chargement…</p>}</Screen>;
  const c = m.commande;
  const lines = m.lignes.filter((l) => l.articleId && l.statutLigne !== 'MANQUANTE');
  const pointed = lines.filter((l) => st.outcome[l.articleId!]);
  const isPickupAtDepot = m.type === 'RETRAIT';

  if (st.phase === 'done') {
    return (
      <Screen title={st.depose ? 'Biens déposés' : 'BL signé'} onBack={onBack}>
        <Banner kind="ok">
          {st.depose
            ? '✓ Dépôt enregistré, BL marqué « non signé, déposé ». Le client reçoit le BL et les photos dès le retour du réseau.'
            : '✓ BL signé et enregistré. Il sera envoyé au client dès le retour du réseau.'}
        </Banner>
        <button type="button" className="btn primary big" onClick={onBack}>
          Mission suivante
        </button>
      </Screen>
    );
  }

  if (reserveFor) {
    return (
      <ReserveForm
        line={reserveFor}
        onCancel={() => setReserveFor(null)}
        onSubmit={async (r, photos, refuse) => {
          for (const p of photos) await enqueuePhoto(p.photoId, p.blob, 0);
          await save({
            ...st,
            outcome: { ...st.outcome, [reserveFor.articleId!]: refuse ? 'REFUSE' : 'LIVRE' },
            reserves: [...st.reserves.filter((x) => x.articleId !== reserveFor.articleId), { ...r, photoIds: photos.map((p) => p.photoId) }],
          });
          setReserveFor(null);
        }}
      />
    );
  }

  if (st.phase === 'sign') {
    return <SignBl mission={m} st={st} onBack={() => save({ ...st, phase: 'unload' })} onSigned={(bl, depose) => save({ ...st, phase: 'done', bl, depose })} />;
  }

  return (
    <Screen title={isPickupAtDepot ? 'Retrait au comptoir' : 'Livraison'} onBack={onBack}>
      {info && <Banner kind="info">{info}</Banner>}
      {!isPickupAtDepot && (
        <section className="card">
          <strong>{c.adresse?.libelle}</strong>
          <small>
            {c.dateConfirmee} {c.creneau ?? ''}
          </small>
          {c.contraintesAcces && <AccessConstraints c={c.contraintesAcces} />}
          {c.contactSite && (
            <p>
              Contact : {c.contactSite.nom}{' '}
              <a className="btn secondary small" href={`tel:${c.contactSite.telephone}`}>
                Appeler
              </a>
            </p>
          )}
          <div className="row-actions">
            <a className="btn secondary" href={navUrl(c.adresse)} target="_blank" rel="noreferrer">
              Naviguer
            </a>
            {!st.departed ? (
              <button type="button" className="btn primary" onClick={async () => (await enqueue({ type: 'DEPART', payload: { missionId } }), save({ ...st, departed: true }))}>
                En route
              </button>
            ) : !st.arrived ? (
              <button
                type="button"
                className="btn primary"
                onClick={async () => {
                  const gps = await currentPosition();
                  await enqueue({ type: 'ARRIVE', payload: { missionId, gps } });
                  if (!gps) setInfo('Position GPS indisponible : arrivée enregistrée sans coordonnées.');
                  await save({ ...st, arrived: true, phase: 'unload' });
                }}
              >
                Arrivé
              </button>
            ) : null}
          </div>
        </section>
      )}

      {(st.arrived || isPickupAtDepot) && (
        <>
          <h2>
            Déchargement · {pointed.length}/{lines.length}
          </h2>
          <Scanner
            expect={['A']}
            burst
            label="Scannez ou cochez chaque article remis"
            onScan={(qr) => {
              const l = lines.find((x) => x.qrCode === qr);
              if (l) void save({ ...st, outcome: { ...st.outcome, [l.articleId!]: 'LIVRE' } });
              else setInfo('Article hors de cette livraison.');
            }}
          />
          <ul className="list">
            {lines.map((l) => {
              const o = st.outcome[l.articleId!];
              const r = st.reserves.find((x) => x.articleId === l.articleId);
              return (
                <li key={l.id} className={`pick ${o === 'LIVRE' ? 'ok' : o === 'REFUSE' ? 'ko' : ''}`}>
                  <button
                    type="button"
                    className="check"
                    aria-pressed={o === 'LIVRE'}
                    aria-label={`Livré : ${l.libelle}`}
                    onClick={() => save({ ...st, outcome: { ...st.outcome, [l.articleId!]: 'LIVRE' } })}
                  >
                    {o === 'LIVRE' ? '✓' : o === 'REFUSE' ? '✕' : ''}
                  </button>
                  <span className="row-main">
                    <strong>{l.libelle}</strong>
                    {r && <small className="warn">Réserve : {r.type.toLowerCase()}{o === 'REFUSE' ? ' (refusé)' : ''}</small>}
                  </span>
                  <button type="button" className="btn secondary small" onClick={() => setReserveFor(l)}>
                    Réserve
                  </button>
                </li>
              );
            })}
          </ul>
          <button type="button" className="btn primary big" disabled={pointed.length !== lines.length} onClick={() => save({ ...st, phase: 'sign' })}>
            Faire signer le BL
          </button>
        </>
      )}
    </Screen>
  );
}

function SignBl({ mission, st, onBack, onSigned }: { mission: MissionDetail; st: LocalState; onBack: () => void; onSigned: (blId: string, depose?: boolean) => void }) {
  const [nom, setNom] = useState('');
  const [qualite, setQualite] = useState('');
  const [svg, setSvg] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const lines = mission.lignes.filter((l) => l.articleId && st.outcome[l.articleId]);
  const livres = lines.filter((l) => st.outcome[l.articleId!] === 'LIVRE');
  const refuses = lines.filter((l) => st.outcome[l.articleId!] === 'REFUSE');
  const hasReserves = st.reserves.length > 0;
  const ready = nom.trim() && qualite.trim() && svg && (!hasReserves || ack);
  // LIV-05 : seulement si le client l'a autorisé, et sans réserve ni refus (personne pour les constater)
  const canDrop = mission.type === 'LIVRAISON' && !!mission.commande?.depotSansSignature && !hasReserves && !refuses.length;
  const [absent, setAbsent] = useState(false);

  if (absent && canDrop) return <DropOff mission={mission} livres={livres.map((l) => l.articleId!)} onBack={() => setAbsent(false)} onDone={(bl) => onSigned(bl, true)} />;

  return (
    <Screen title="Signature du BL" onBack={onBack}>
      <section className="card recap">
        <p>
          <strong>{livres.length}</strong> article(s) livré(s){refuses.length ? `, ${refuses.length} refusé(s)` : ''}
        </p>
        <ul>
          {lines.map((l) => (
            <li key={l.id}>
              {st.outcome[l.articleId!] === 'REFUSE' ? '✕' : '✓'} {l.libelle}
              {st.reserves.find((r) => r.articleId === l.articleId) && ` — réserve : ${st.reserves.find((r) => r.articleId === l.articleId)!.type.toLowerCase()}`}
            </li>
          ))}
        </ul>
      </section>
      {canDrop && (
        <button type="button" className="btn secondary big" onClick={() => setAbsent(true)}>
          Destinataire absent : déposer sans signature
        </button>
      )}
      <label>
        Nom du réceptionnaire
        <input value={nom} onChange={(e) => setNom(e.target.value)} autoComplete="off" />
      </label>
      <label>
        Qualité (ex. chef de chantier)
        <input value={qualite} onChange={(e) => setQualite(e.target.value)} autoComplete="off" />
      </label>
      <SignaturePad onChange={setSvg} />
      {hasReserves && (
        <label className="checkbox">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Le réceptionnaire valide les réserves ci-dessus
        </label>
      )}
      <button
        type="button"
        className="btn primary big"
        disabled={!ready || busy}
        onClick={async () => {
          setBusy(true);
          const base = {
            missionId: mission.id,
            blId: uuidv7(),
            livres: livres.map((l) => l.articleId!),
            refuses: refuses.map((l) => l.articleId!),
            reserves: st.reserves.map(({ photoUrls: _u, ...r }) => r),
            signataire: { nom: nom.trim(), qualite: qualite.trim() },
            signatureSvg: svg!,
            signedAt: new Date().toISOString(),
          };
          // empreinte SHA-256 calculée sur le terminal, vérifiée par le serveur (§4.3)
          const empreinte = await blFingerprint(base);
          const gps = await currentPosition(4000);
          await enqueue({ type: 'BL_SIGN', payload: { ...base, gps, empreinte } });
          onSigned(base.blId);
        }}
      >
        Valider le BL
      </button>
    </Screen>
  );
}

/** LIV-05 : dépôt sans signature, 3 photos au moins et le lieu exact, BL « non signé, déposé ». */
function DropOff({ mission, livres, onBack, onDone }: { mission: MissionDetail; livres: string[]; onBack: () => void; onDone: (blId: string) => void }) {
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [lieu, setLieu] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = photos.length >= 3 && lieu.trim().length >= 3;
  return (
    <Screen title="Destinataire absent" onBack={onBack}>
      <Banner kind="info">Le client a autorisé le dépôt sans signature. Photographiez les biens déposés et l’endroit, puis indiquez précisément où ils sont.</Banner>
      <p className="hint">{livres.length} bien(s) déposé(s) · commande {mission.commande?.numero}</p>
      <PhotoCapture photos={photos} onChange={setPhotos} min={3} max={10} label="Photos du dépôt" />
      <label>
        Lieu exact du dépôt
        <textarea rows={2} value={lieu} maxLength={300} onChange={(e) => setLieu(e.target.value)} placeholder="Ex. dans le bungalow de chantier, porte de gauche" />
      </label>
      <button
        type="button"
        className="btn primary big"
        disabled={!ready || busy}
        onClick={async () => {
          setBusy(true);
          for (const p of photos) await enqueuePhoto(p.photoId, p.blob, 0);
          const base = {
            missionId: mission.id,
            blId: uuidv7(),
            livres,
            refuses: [],
            reserves: [],
            signataire: { nom: '', qualite: '' },
            signatureSvg: '',
            signedAt: new Date().toISOString(),
            depot: { lieu: lieu.trim(), photoIds: photos.map((p) => p.photoId) },
          };
          const empreinte = await blFingerprint(base);
          const gps = await currentPosition(4000);
          await enqueue({ type: 'BL_SIGN', payload: { ...base, gps, empreinte } });
          onDone(base.blId);
        }}
      >
        Valider le dépôt
      </button>
    </Screen>
  );
}

function ReserveForm({ line, onSubmit, onCancel }: { line: MissionLine; onSubmit: (r: ReserveInput, photos: CapturedPhoto[], refuse: boolean) => void; onCancel: () => void }) {
  const [type, setType] = useState<ReserveInput['type'] | null>(null);
  const [photos, setPhotos] = useState<CapturedPhoto[]>([]);
  const [comment, setComment] = useState('');
  const [refuse, setRefuse] = useState(false);
  return (
    <Screen title="Réserve" onBack={onCancel}>
      <p>
        <strong>{line.libelle}</strong>
      </p>
      <Choice label="Type" value={type} options={RESERVE_TYPES.map((t) => ({ value: t.value, label: t.label }))} onChange={setType} />
      <PhotoCapture photos={photos} onChange={setPhotos} min={1} max={4} />
      <label>
        Commentaire
        <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={refuse} onChange={(e) => setRefuse(e.target.checked)} /> Article refusé (il repart au dépôt)
      </label>
      <button type="button" className="btn primary big" disabled={!type || !photos.length} onClick={() => onSubmit({ articleId: line.articleId!, type: refuse && type === 'AUTRE' ? 'REFUS' : type!, commentaire: comment || undefined }, photos, refuse)}>
        Enregistrer la réserve
      </button>
    </Screen>
  );
}

/** LIV-06 : collecte chez le client, BL d'enlèvement signé, étiquetage provisoire possible. */
export function Pickup({ missionId, onBack }: { missionId: string; onBack: () => void }) {
  const [m, setM] = useState<MissionDetail | undefined>();
  const [items, setItems] = useState<{ articleId: string; qr?: string; libelle: string; photos: CapturedPhoto[] }[]>([]);
  const [draft, setDraft] = useState<{ libelle: string; qr?: string; photos: CapturedPhoto[] } | null>(null);
  const [signing, setSigning] = useState(false);
  const [nom, setNom] = useState('');
  const [qualite, setQualite] = useState('');
  const [svg, setSvg] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [departed, setDeparted] = useState(false);

  useEffect(() => void loadMission(missionId).then((r) => setM(r.data)), [missionId]);
  if (!m?.commande) return <Screen title="Collecte" onBack={onBack}>{<p className="hint">Chargement…</p>}</Screen>;

  if (done) {
    return (
      <Screen title="Collecte" onBack={onBack}>
        <Banner kind="ok">✓ BL d’enlèvement signé : {items.length} bien(s) pris en charge.</Banner>
      </Screen>
    );
  }

  if (draft) {
    return (
      <Screen title="Bien enlevé" onBack={() => setDraft(null)}>
        <label>
          Désignation
          <input value={draft.libelle} onChange={(e) => setDraft({ ...draft, libelle: e.target.value })} />
        </label>
        <PhotoCapture photos={draft.photos} onChange={(photos) => setDraft({ ...draft, photos })} min={1} />
        {draft.qr ? <Banner kind="ok">Étiquette {draft.qr}</Banner> : <Scanner expect={['A']} label="Étiquette vierge (facultatif)" onScan={(qr) => setDraft({ ...draft, qr })} />}
        <button
          type="button"
          className="btn primary big"
          disabled={!draft.libelle.trim() || !draft.photos.length}
          onClick={() => {
            setItems([...items, { articleId: uuidv7(), ...draft }]);
            setDraft(null);
          }}
        >
          Ajouter
        </button>
      </Screen>
    );
  }

  return (
    <Screen title="Collecte" onBack={onBack}>
      <section className="card">
        <strong>{m.commande.adresse?.libelle}</strong>
        <div className="row-actions">
          <a className="btn secondary" href={navUrl(m.commande.adresse)} target="_blank" rel="noreferrer">
            Naviguer
          </a>
          {!departed && (
            <button type="button" className="btn primary" onClick={async () => (await enqueue({ type: 'DEPART', payload: { missionId } }), setDeparted(true))}>
              En route
            </button>
          )}
        </div>
      </section>
      {!signing ? (
        <>
          <h2>Biens enlevés ({items.length})</h2>
          <ul className="list">
            {items.map((i) => (
              <li key={i.articleId} className="pick">
                <img src={i.photos[0]?.url} alt="" />
                <span className="row-main">
                  <strong>{i.libelle}</strong>
                  <small>{i.qr ?? 'sans étiquette'}</small>
                </span>
              </li>
            ))}
          </ul>
          <button type="button" className="btn secondary big" onClick={() => setDraft({ libelle: '', photos: [] })}>
            + Ajouter un bien
          </button>
          <button type="button" className="btn primary big" disabled={!items.length} onClick={() => setSigning(true)}>
            Faire signer le BL d’enlèvement
          </button>
        </>
      ) : (
        <>
          <label>
            Nom du remettant
            <input value={nom} onChange={(e) => setNom(e.target.value)} />
          </label>
          <label>
            Qualité
            <input value={qualite} onChange={(e) => setQualite(e.target.value)} />
          </label>
          <SignaturePad onChange={setSvg} />
          <button
            type="button"
            className="btn primary big"
            disabled={!nom.trim() || !qualite.trim() || !svg}
            onClick={async () => {
              for (const i of items) for (const p of i.photos) await enqueuePhoto(p.photoId, p.blob, 0);
              const base = {
                missionId,
                blId: uuidv7(),
                articles: items.map((i) => ({ articleId: i.articleId, qr: i.qr, libelle: i.libelle, photos: i.photos.map((p) => ({ photoId: p.photoId })) })),
                signataire: { nom: nom.trim(), qualite: qualite.trim() },
                signatureSvg: svg!,
                signedAt: new Date().toISOString(),
              };
              const empreinte = await pickupFingerprint(base);
              await enqueue({ type: 'PICKUP_SIGN', payload: { ...base, gps: await currentPosition(4000), empreinte } });
              setDone(true);
            }}
          >
            Valider l’enlèvement
          </button>
        </>
      )}
    </Screen>
  );
}

function AccessConstraints({ c }: { c: Record<string, unknown> }) {
  const parts: string[] = [];
  if (c.etage !== undefined) parts.push(`Étage ${c.etage}`);
  if (c.accesPL === false) parts.push('Pas d’accès PL');
  if (c.hauteurLimiteM) parts.push(`Hauteur limite ${c.hauteurLimiteM} m`);
  if (c.horairesChantier) parts.push(`Horaires : ${c.horairesChantier}`);
  if (c.consignes) parts.push(String(c.consignes));
  return parts.length ? <p className="constraints">{parts.join(' · ')}</p> : null;
}

function navUrl(a: { libelle?: string; lat?: number; lng?: number } | null): string {
  if (a?.lat !== undefined && a?.lng !== undefined) return `https://www.google.com/maps/dir/?api=1&destination=${a.lat},${a.lng}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(a?.libelle ?? '')}`;
}
