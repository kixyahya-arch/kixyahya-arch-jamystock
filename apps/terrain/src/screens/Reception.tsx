import { useEffect, useMemo, useState } from 'react';
import { ARTICLE_CONDITIONS, uuidv7, type ArticleCondition } from '@jamystock/domain/browser';
import { Scanner } from '../components/Scanner';
import { PhotoCapture, type CapturedPhoto } from '../components/PhotoCapture';
import { Banner, Choice, Screen } from '../components/ui';
import { enqueue, enqueuePhoto } from '../lib/outbox';
import { cacheGet, markGet, markSet } from '../lib/db';
import { loadReceptions, type Bootstrap, type Reception } from '../lib/data';

const CONDITION_LABEL: Record<ArticleCondition, string> = { NEUF: 'Neuf', BON: 'Bon', USE: 'Usé', ENDOMMAGE: 'Endommagé' };
const ICONS: Record<string, string> = { desk: '🗄', chair: '🪑', sign: '🪧', building: '🏗', box: '📦' };

/** REC-01 : réceptions attendues (collectes enlevées). */
export function Receptions({ onBack, open }: { onBack: () => void; open: (r: Reception) => void }) {
  const [list, setList] = useState<Reception[] | undefined>();
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    void loadReceptions().then((r) => {
      setList(r.data);
      setOffline(r.offline);
    });
  }, []);
  return (
    <Screen title="Réceptions attendues" onBack={onBack}>
      {offline && <Banner kind="info">Hors réseau : liste du dernier chargement.</Banner>}
      {list?.length === 0 && <p className="hint">Aucune réception attendue.</p>}
      <ul className="list">
        {list?.map((r) => (
          <li key={r.commandeId}>
            <button type="button" className="row" onClick={() => open(r)}>
              <span className="row-main">
                <strong>{r.client}</strong> · {r.numero}
                {r.projet && <small>{r.projet}</small>}
              </span>
              <span className="pill">
                {r.nbRanges}/{r.nbArticles}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Screen>
  );
}

type Step =
  | { s: 'scan-article' }
  | { s: 'form'; qr: string; articleId: string; known?: { libelle: string } }
  | { s: 'scan-location'; qr: string; libelle: string }
  | { s: 'pallet'; umQr: string; count: number };

/**
 * §4.1 : entrée en stock en ≤ 45 s — scan de l'étiquette, photos, catégorie, état, puis scan de l'emplacement.
 * Variante palette : scanner l'UM, les articles en rafale, puis l'emplacement.
 */
export function ReceptionFlow({ reception, onBack }: { reception: Reception; onBack: () => void }) {
  const [step, setStep] = useState<Step>({ s: 'scan-article' });
  const [done, setDone] = useState<string[]>([]);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [boot, setBoot] = useState<Bootstrap | undefined>();
  const [relabel, setRelabel] = useState<{ id: string; libelle: string } | null>(null);
  const markKey = `reception:${reception.commandeId}`;

  useEffect(() => {
    void cacheGet<Bootstrap>('bootstrap').then(setBoot);
    void markGet<string[]>(markKey, []).then(setDone);
  }, [markKey]);

  const remember = async (qr: string) => {
    const next = [...new Set([...done, qr])];
    setDone(next);
    await markSet(markKey, next);
  };

  const provisional = reception.articles.filter((a) => a.qrCode.startsWith('P-') && !done.includes(a.id));
  const locationName = (qr: string) => boot?.emplacements.find((e) => e.qrCode === qr)?.chemin ?? qr;

  return (
    <Screen title={`Réception ${reception.numero}`} onBack={onBack}>
      <p className="hint">
        {reception.client}
        {reception.projet ? ` · ${reception.projet}` : ''} · {done.length} traité(s) sur {reception.nbArticles} annoncé(s)
      </p>
      {message && <Banner kind={message.kind}>{message.text}</Banner>}

      {step.s === 'scan-article' && (
        <>
          <Scanner
            expect={['A', 'U']}
            label="Scannez l'étiquette de l'objet (ou d'une palette)"
            onScan={(qr, type) => {
              setMessage(null);
              if (type === 'U') {
                void enqueue({ type: 'UM_CREATE', payload: { umId: uuidv7(), qr, umType: 'PALETTE' } });
                setStep({ s: 'pallet', umQr: qr, count: 0 });
                return;
              }
              const known = reception.articles.find((a) => a.qrCode === qr);
              if (relabel) {
                setStep({ s: 'form', qr, articleId: relabel.id, known: { libelle: relabel.libelle } });
                setRelabel(null);
              } else {
                setStep({ s: 'form', qr, articleId: known?.id ?? uuidv7(), known: known && { libelle: known.libelle } });
              }
            }}
          />
          {provisional.length > 0 && (
            <section>
              <h2>Biens enlevés sans étiquette</h2>
              <p className="hint">Touchez le bien, collez une étiquette vierge puis scannez-la.</p>
              <ul className="list">
                {provisional.map((a) => (
                  <li key={a.id}>
                    <button type="button" className={`row ${relabel?.id === a.id ? 'selected' : ''}`} onClick={() => setRelabel({ id: a.id, libelle: a.libelle })}>
                      <span className="row-main">{a.libelle}</span>
                      <span className="pill">{relabel?.id === a.id ? 'Scannez l’étiquette' : 'Étiqueter'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {step.s === 'form' && (
        <ArticleForm
          key={step.qr}
          qr={step.qr}
          initial={step.known?.libelle}
          categories={boot?.categories ?? []}
          onCancel={() => setStep({ s: 'scan-article' })}
          onSubmit={async (f) => {
            for (const p of f.photos) await enqueuePhoto(p.photoId, p.blob, 1);
            await enqueue({
              type: 'ARTICLE_CREATE',
              payload: {
                articleId: step.articleId,
                qr: step.qr,
                commandeId: reception.commandeId,
                libelle: f.libelle,
                categorieId: f.categorieId,
                etat: f.etat,
                description: f.description || undefined,
                longueurM: f.longueurM,
                largeurM: f.largeurM,
                hauteurM: f.hauteurM,
                photos: f.photos.map((p) => ({ photoId: p.photoId })),
              },
            });
            await remember(step.articleId);
            setStep({ s: 'scan-location', qr: step.qr, libelle: f.libelle });
          }}
        />
      )}

      {step.s === 'scan-location' && (
        <Scanner
          expect={['E', 'U']}
          label={`Rangez « ${step.libelle} » : scannez l'emplacement ou la palette`}
          onScan={async (qr, type) => {
            if (type === 'U') await enqueue({ type: 'UM_ADD', payload: { umQr: qr, articleQr: step.qr } });
            else await enqueue({ type: 'ARTICLE_STORE', payload: { articleQr: step.qr, locationQr: qr } });
            setMessage({ kind: 'ok', text: `✓ « ${step.libelle} » → ${type === 'U' ? 'palette' : locationName(qr)}` });
            setStep({ s: 'scan-article' });
          }}
        />
      )}

      {step.s === 'pallet' && (
        <PalletFlow
          umQr={step.umQr}
          reception={reception}
          categories={boot?.categories ?? []}
          onItem={(id) => void remember(id)}
          onStored={(loc) => {
            setMessage({ kind: 'ok', text: `✓ Palette rangée → ${locationName(loc)}` });
            setStep({ s: 'scan-article' });
          }}
        />
      )}

      {step.s === 'scan-article' && (
        <div className="footer-actions">
          <button
            type="button"
            className="btn primary"
            onClick={async () => {
              await enqueue({ type: 'RECEPTION_CLOSE', payload: { commandeId: reception.commandeId } });
              setMessage({ kind: 'info', text: 'Clôture envoyée : le client recevra le récapitulatif photo.' });
            }}
          >
            Clôturer la réception
          </button>
        </div>
      )}
    </Screen>
  );
}

interface FormValue {
  libelle: string;
  categorieId: string | null;
  etat: ArticleCondition;
  description: string;
  longueurM?: number;
  largeurM?: number;
  hauteurM?: number;
  photos: CapturedPhoto[];
}

function ArticleForm({
  qr,
  initial,
  categories,
  onSubmit,
  onCancel,
}: {
  qr: string;
  initial?: string;
  categories: Bootstrap['categories'];
  onSubmit: (v: FormValue) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [v, setV] = useState<FormValue>({ libelle: initial ?? '', categorieId: null, etat: 'BON', description: '', photos: [] });
  const cat = useMemo(() => categories.find((c) => c.id === v.categorieId), [categories, v.categorieId]);
  const valid = v.photos.length >= 1 && v.libelle.trim().length > 0;
  const num = (s: string) => (s === '' ? undefined : Number(s.replace(',', '.')));

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void onSubmit(v);
      }}
    >
      <p className="hint">Étiquette {qr}</p>
      <PhotoCapture photos={v.photos} onChange={(photos) => setV({ ...v, photos })} />
      <Choice
        label="Catégorie"
        value={v.categorieId}
        options={categories.map((c) => ({ value: c.id, label: c.nom, icon: ICONS[c.icone ?? ''] ?? '•' }))}
        onChange={(id) => {
          const c = categories.find((x) => x.id === id)!;
          // dimensions pré-remplies par la catégorie (REC-02)
          setV({ ...v, categorieId: id, libelle: v.libelle || c.nom, longueurM: c.longueurM ?? undefined, largeurM: c.largeurM ?? undefined, hauteurM: c.hauteurM ?? undefined });
        }}
      />
      <Choice label="État" value={v.etat} options={ARTICLE_CONDITIONS.map((c) => ({ value: c, label: CONDITION_LABEL[c] }))} onChange={(etat) => setV({ ...v, etat })} />
      <label>
        Libellé
        <input value={v.libelle} onChange={(e) => setV({ ...v, libelle: e.target.value })} required />
      </label>
      <div className="dims">
        {(['longueurM', 'largeurM', 'hauteurM'] as const).map((k) => (
          <label key={k}>
            {k === 'longueurM' ? 'L' : k === 'largeurM' ? 'l' : 'H'} (m)
            <input inputMode="decimal" value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: num(e.target.value) })} placeholder={cat ? String(cat[k] ?? '') : ''} />
          </label>
        ))}
      </div>
      <label>
        Description (facultatif, dictée possible)
        <textarea rows={2} value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} />
      </label>
      <div className="footer-actions">
        <button type="button" className="btn secondary" onClick={onCancel}>
          Annuler
        </button>
        <button className="btn primary big" disabled={!valid}>
          Valider et ranger
        </button>
      </div>
    </form>
  );
}

/** REC-04 : palette — articles scannés en rafale, chacun avec sa photo, puis emplacement. */
function PalletFlow({
  umQr,
  reception,
  categories,
  onItem,
  onStored,
}: {
  umQr: string;
  reception: Reception;
  categories: Bootstrap['categories'];
  onItem: (articleId: string) => void;
  onStored: (locationQr: string) => void;
}) {
  const [pending, setPending] = useState<{ qr: string; id: string; libelle?: string } | null>(null);
  const [count, setCount] = useState(0);
  const [closing, setClosing] = useState(false);

  if (pending) {
    return (
      <ArticleForm
        qr={pending.qr}
        initial={pending.libelle}
        categories={categories}
        onCancel={() => setPending(null)}
        onSubmit={async (f) => {
          for (const p of f.photos) await enqueuePhoto(p.photoId, p.blob, 1);
          await enqueue({
            type: 'ARTICLE_CREATE',
            payload: {
              articleId: pending.id, qr: pending.qr, commandeId: reception.commandeId, libelle: f.libelle, categorieId: f.categorieId, etat: f.etat,
              longueurM: f.longueurM, largeurM: f.largeurM, hauteurM: f.hauteurM, photos: f.photos.map((p) => ({ photoId: p.photoId })),
            },
          });
          await enqueue({ type: 'UM_ADD', payload: { umQr, articleQr: pending.qr } });
          onItem(pending.id);
          setCount((n) => n + 1);
          setPending(null);
        }}
      />
    );
  }
  return (
    <>
      <Banner kind="info">
        Palette {umQr} · {count} article(s)
      </Banner>
      {closing ? (
        <Scanner expect={['E']} label="Scannez l'emplacement de la palette" onScan={async (qr) => (await enqueue({ type: 'UM_STORE', payload: { umQr, locationQr: qr } }), onStored(qr))} />
      ) : (
        <>
          <Scanner
            expect={['A']}
            burst
            label="Scannez les articles de la palette"
            onScan={(qr) => {
              const known = reception.articles.find((a) => a.qrCode === qr);
              setPending({ qr, id: known?.id ?? uuidv7(), libelle: known?.libelle });
            }}
          />
          <button type="button" className="btn primary big" disabled={count === 0} onClick={() => setClosing(true)}>
            Ranger la palette
          </button>
        </>
      )}
    </>
  );
}

/** Déplacement libre d'un article ou d'une palette (TRANSFER). */
export function Transfer({ onBack }: { onBack: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Screen title="Déplacer" onBack={onBack}>
      {msg && <Banner kind="ok">{msg}</Banner>}
      {!qr ? (
        <Scanner expect={['A', 'U']} label="Scannez l'article ou la palette" onScan={(q) => (setQr(q), setMsg(null))} />
      ) : (
        <Scanner
          expect={['E']}
          label={`Nouvel emplacement pour ${qr}`}
          onScan={async (loc) => {
            await enqueue({ type: 'TRANSFER', payload: { qr, locationQr: loc } });
            setMsg(`✓ ${qr} déplacé`);
            setQr(null);
          }}
        />
      )}
    </Screen>
  );
}
