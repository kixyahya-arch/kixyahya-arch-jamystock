import { useEffect, useMemo, useState } from 'react';
import { ARTICLE_CONDITIONS, uuidv7, type ArticleCondition } from '@jamystock/domain/browser';
import { Scanner } from '../components/Scanner';
import { PhotoCapture, type CapturedPhoto } from '../components/PhotoCapture';
import { Banner, Choice, Screen } from '../components/ui';
import { enqueue, enqueuePhoto, flush } from '../lib/outbox';
import { api, apiBlob, ApiError, NetworkError } from '../lib/api';
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

interface Dims {
  longueurM?: number;
  largeurM?: number;
  hauteurM?: number;
}

type Step =
  | { s: 'scan-article' }
  | { s: 'form'; qr: string; articleId: string; known?: { libelle: string } }
  | { s: 'scan-location'; qr: string; libelle: string; articleId: string; dims: Dims }
  | { s: 'series'; libelle: string; articles: { id: string; qrCode: string }[] }
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
  const [last, setLast] = useState<{ articleId: string; libelle: string } | null>(null);
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
        {reception.projet ? ` · ${reception.projet}` : ''} · {reception.nbArticles} annoncé(s) · {done.length} traité(s)
      </p>
      {message && <Banner kind={message.kind}>{message.text}</Banner>}

      {step.s === 'scan-article' && (
        <>
          <Scanner
            expect={['A', 'U']}
            label="Scannez l'étiquette de l'objet (ou d'une palette)"
            onScan={(qr, type) => {
              setMessage(null);
              setLast(null);
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
            setStep({ s: 'scan-location', qr: step.qr, libelle: f.libelle, articleId: step.articleId, dims: { longueurM: f.longueurM, largeurM: f.largeurM, hauteurM: f.hauteurM } });
          }}
        />
      )}

      {step.s === 'scan-location' && (
        <>
          <Suggestions key={step.articleId} commandeId={reception.commandeId} dims={step.dims} />
          <Scanner
            expect={['E', 'U']}
            label={`Rangez « ${step.libelle} » : scannez l'emplacement ou la palette`}
            onScan={async (qr, type) => {
              if (type === 'U') await enqueue({ type: 'UM_ADD', payload: { umQr: qr, articleQr: step.qr } });
              else await enqueue({ type: 'ARTICLE_STORE', payload: { articleQr: step.qr, locationQr: qr } });
              setMessage({ kind: 'ok', text: `✓ « ${step.libelle} » → ${type === 'U' ? 'palette' : locationName(qr)}` });
              setLast({ articleId: step.articleId, libelle: step.libelle });
              setStep({ s: 'scan-article' });
            }}
          />
        </>
      )}

      {step.s === 'series' && (
        <SeriesFlow
          commandeId={reception.commandeId}
          libelle={step.libelle}
          articles={step.articles}
          locationName={locationName}
          onDone={(n, loc) => {
            setMessage({ kind: 'ok', text: `✓ ${n} copie(s) de « ${step.libelle} » → ${locationName(loc)}` });
            setStep({ s: 'scan-article' });
          }}
          onCancel={() => setStep({ s: 'scan-article' })}
        />
      )}

      {step.s === 'scan-article' && last && (
        <DuplicateOffer
          key={last.articleId}
          source={last}
          onCreated={(articles) => {
            void Promise.all(articles.map((a) => remember(a.id)));
            setMessage(null);
            setLast(null);
            setStep({ s: 'series', libelle: last.libelle, articles });
          }}
          onError={(text) => setMessage({ kind: 'error', text })}
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

interface Suggestion {
  id: string;
  code: string;
  chemin: string;
  qrCode: string;
  libreM2: number;
  raison: string;
}

/** REC-06 : les 3 emplacements libres les plus logiques (même projet, même allée, place suffisante). */
function Suggestions({ commandeId, articleId, dims = {}, nombre }: { commandeId: string; articleId?: string; dims?: Dims; nombre?: number }) {
  const [state, setState] = useState<{ list?: Suggestion[]; offline?: boolean }>({});
  useEffect(() => {
    const q = new URLSearchParams(articleId ? { articleId } : { commandeId });
    for (const [k, v] of Object.entries(dims)) if (v) q.set(k, String(v));
    if (nombre && nombre > 1) q.set('nombre', String(nombre));
    api<{ suggestions: Suggestion[] }>(`/field/locations/suggest?${q}`)
      .then((r) => setState({ list: r.suggestions }))
      .catch((e) => setState({ list: [], offline: e instanceof NetworkError }));
  }, [commandeId, articleId, dims, nombre]);
  if (state.offline) return <p className="hint">Hors réseau : pas de suggestion d’emplacement, rangez où il y a de la place.</p>;
  if (!state.list) return <p className="hint">Recherche d’un emplacement…</p>;
  if (!state.list.length) return <p className="hint">Aucun emplacement libre assez grand : voyez avec le chef de quai.</p>;
  return (
    <section className="suggest">
      <h2>Emplacements suggérés</h2>
      <ol className="list">
        {state.list.map((s, i) => (
          <li key={s.id} className={`suggest-item ${i === 0 ? 'best' : ''}`}>
            <strong>{s.chemin}</strong>
            <small>
              {s.raison} · {s.libreM2.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} m² libres
            </small>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** REC-05 : « encore N comme celui-ci » — l'objet qui vient d'être rangé sert de modèle. */
function DuplicateOffer({
  source,
  onCreated,
  onError,
}: {
  source: { articleId: string; libelle: string };
  onCreated: (a: { id: string; qrCode: string }[]) => void;
  onError: (text: string) => void;
}) {
  const [n, setN] = useState(1);
  const [busy, setBusy] = useState(false);
  return (
    <section className="dup-offer">
      <p>
        Plusieurs « {source.libelle} » identiques ? Créez les copies d’un coup, avec la même photo et les mêmes dimensions.
      </p>
      <div className="dup-row">
        <label>
          Encore
          <input type="number" inputMode="numeric" min={1} max={50} value={n} onChange={(e) => setN(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
          comme celui-ci
        </label>
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await flush();
              const r = await api<{ articles: { id: string; qrCode: string }[] }>(`/field/articles/${source.articleId}/duplicate`, {
                method: 'POST',
                body: JSON.stringify({ nombre: n }),
              });
              onCreated(r.articles);
            } catch (e) {
              onError(e instanceof NetworkError ? 'Hors réseau : la duplication demande une connexion.' : e instanceof ApiError ? e.message : 'Duplication impossible.');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Création…' : 'Créer les copies'}
        </button>
      </div>
    </section>
  );
}

/** Série de copies : imprimer leurs étiquettes, les coller, puis ranger toute la série d'un scan d'emplacement. */
function SeriesFlow({
  commandeId,
  libelle,
  articles,
  locationName,
  onDone,
  onCancel,
}: {
  commandeId: string;
  libelle: string;
  articles: { id: string; qrCode: string }[];
  locationName: (qr: string) => string;
  onDone: (n: number, loc: string) => void;
  onCancel: () => void;
}) {
  const [printing, setPrinting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const print = async (format: 'ZEBRA_50x25' | 'L7651') => {
    setPrinting(format);
    setError(null);
    try {
      const blob = await apiBlob('/bo/warehouse/labels/articles', { ids: articles.map((a) => a.id), format });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setError(e instanceof NetworkError ? 'Hors réseau : impression impossible.' : (e as Error).message);
    } finally {
      setPrinting(null);
    }
  };
  return (
    <section className="series">
      <h2>
        {articles.length} copie(s) de « {libelle} »
      </h2>
      <p className="hint">1. Imprimez et collez les étiquettes. 2. Scannez l’emplacement : toute la série y est rangée.</p>
      {error && <Banner kind="error">{error}</Banner>}
      <div className="dup-row">
        <button type="button" className="btn" disabled={!!printing} onClick={() => void print('ZEBRA_50x25')}>
          {printing === 'ZEBRA_50x25' ? 'Préparation…' : 'Étiquettes Zebra'}
        </button>
        <button type="button" className="btn" disabled={!!printing} onClick={() => void print('L7651')}>
          {printing === 'L7651' ? 'Préparation…' : 'Planche A4'}
        </button>
      </div>
      <ul className="scan-list">
        {articles.map((a) => (
          <li key={a.id}>
            <span className="mono">{a.qrCode}</span>
          </li>
        ))}
      </ul>
      <Suggestions commandeId={commandeId} articleId={articles[0]?.id} nombre={articles.length} />
      <Scanner
        expect={['E']}
        label="Scannez l'emplacement de la série"
        onScan={async (qr) => {
          for (const a of articles) await enqueue({ type: 'ARTICLE_STORE', payload: { articleQr: a.qrCode, locationQr: qr } });
          onDone(articles.length, qr);
        }}
      />
      <button type="button" className="btn secondary" onClick={onCancel}>
        Ranger plus tard
      </button>
    </section>
  );
}
