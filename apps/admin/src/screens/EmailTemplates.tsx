import { useEffect, useRef, useState } from 'react';
import { api, get, post, put } from '../lib/api';
import { href } from '../lib/router';
import { dateFr } from '../lib/labels';
import { Banner, EmailTabs, StatusPill } from '../components/ui';

interface Row {
  modele: string;
  libelle: string;
  sujet: string;
  personnalise: boolean;
  modifieLe: string | null;
  modifiePar: string | null;
}
interface Text {
  sujet: string;
  corps: string;
  bouton: string | null;
}
interface Detail {
  modele: string;
  libelle: string;
  reperes: string[];
  defaut: Text;
  actuel: Text | null;
  apercu: { subject: string; html: string };
}

/** §6.3 : liste des modèles d'e-mails, personnalisés ou d'origine. */
export function EmailTemplates() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<Row[]>('/bo/email-templates').then(setRows, (e) => setError((e as Error).message));
  }, []);
  return (
    <>
      <section className="bo-head">
        <div>
          <p className="eyebrow">— Clients</p>
          <h1>E-mails</h1>
          <p className="lead">Adaptez le texte des messages envoyés aux clients. La mise en page, l’en-tête et le lien du bouton restent ceux de JAMYSTOCK.</p>
        </div>
      </section>
      <EmailTabs active="modeles" />
      {error && <Banner kind="error">{error}</Banner>}
      {!rows ? (
        !error && <p className="hint">Chargement…</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Message</th>
                <th>Objet</th>
                <th>Texte</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.modele}>
                  <td>
                    <a href={href({ name: 'modele-email', id: r.modele })}>
                      <strong>{r.libelle}</strong>
                    </a>
                  </td>
                  <td className="muted">{r.sujet}</td>
                  <td>
                    {r.personnalise ? (
                      <>
                        <StatusPill label="Personnalisé" tone="lime" />
                        <div className="muted small">
                          {dateFr(r.modifieLe)}
                          {r.modifiePar ? ` · ${r.modifiePar}` : ''}
                        </div>
                      </>
                    ) : (
                      <span className="muted">D’origine</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Édition d'un modèle : sujet, paragraphes, bouton ; aperçu avec des données d'exemple. */
export function EmailTemplateEditor({ id }: { id: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [t, setT] = useState<Text | null>(null);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLTextAreaElement>(null);

  const load = () =>
    get<Detail>(`/bo/email-templates/${id}`).then(
      (r) => {
        setD(r);
        setT(r.actuel ?? r.defaut);
        setPreview(r.apercu);
      },
      (e) => setError((e as Error).message),
    );
  useEffect(() => void load(), [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // aperçu recalculé pendant la frappe
  useEffect(() => {
    if (!t || !d) return;
    const h = setTimeout(() => {
      post<{ subject: string; html: string }>(`/bo/email-templates/${id}/apercu`, t).then(
        (p) => {
          setPreview(p);
          setError(null);
        },
        (e) => setError((e as Error).message),
      );
    }, 400);
    return () => clearTimeout(h);
  }, [t, d, id]);

  const insert = (k: string) => {
    if (!t) return;
    const el = body.current;
    const mark = `{{${k}}}`;
    if (!el) return setT({ ...t, corps: t.corps + mark });
    const [a, b] = [el.selectionStart, el.selectionEnd];
    setT({ ...t, corps: t.corps.slice(0, a) + mark + t.corps.slice(b) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + mark.length, a + mark.length);
    });
  };

  if (!d || !t) return error ? <Banner kind="error">{error}</Banner> : <p className="hint">Chargement…</p>;
  const changed = JSON.stringify(t) !== JSON.stringify(d.actuel ?? d.defaut);
  return (
    <>
      <a className="back" href={href({ name: 'modeles-email' })}>
        ← Modèles d’e-mails
      </a>
      <section className="bo-head">
        <div>
          <p className="eyebrow">— Modèle d’e-mail</p>
          <h1>{d.libelle}</h1>
          <p className="lead">{d.actuel ? 'Texte personnalisé : il remplace le texte d’origine pour tous les envois.' : 'Texte d’origine. Modifiez-le puis enregistrez pour l’utiliser à chaque envoi.'}</p>
        </div>
      </section>
      {notice && <Banner kind="ok">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
      <div className="template-layout">
        <form
          className="panel template-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await put(`/bo/email-templates/${id}`, t);
              setNotice('Modèle enregistré : les prochains e-mails utiliseront ce texte.');
              await load();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Objet
            <input value={t.sujet} maxLength={200} required onChange={(e) => setT({ ...t, sujet: e.target.value })} />
          </label>
          <label>
            Texte <span className="muted small">(une ligne vide sépare deux paragraphes ; « Bonjour … » est ajouté automatiquement)</span>
            <textarea ref={body} rows={9} value={t.corps} maxLength={4000} required onChange={(e) => setT({ ...t, corps: e.target.value })} />
          </label>
          {d.reperes.length > 0 && (
            <div className="reperes" aria-label="Insérer une donnée">
              <span className="muted small">Insérer :</span>
              {d.reperes.map((k) => (
                <button key={k} type="button" className="chip" onClick={() => insert(k)}>
                  {`{{${k}}}`}
                </button>
              ))}
            </div>
          )}
          {d.defaut.bouton && (
            <label>
              Texte du bouton
              <input value={t.bouton ?? ''} maxLength={60} placeholder={d.defaut.bouton} onChange={(e) => setT({ ...t, bouton: e.target.value || null })} />
            </label>
          )}
          <div className="row-actions">
            <button type="submit" className="btn primary" disabled={busy || !changed}>
              Enregistrer
            </button>
            {changed && (
              <button type="button" className="btn" onClick={() => setT(d.actuel ?? d.defaut)}>
                Annuler les modifications
              </button>
            )}
            <span className="spacer" />
            {d.actuel && (
              <button
                type="button"
                className="link"
                onClick={async () => {
                  try {
                    await api(`/bo/email-templates/${id}`, { method: 'DELETE' });
                    setNotice('Texte d’origine rétabli.');
                    await load();
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }}
              >
                Revenir au texte d’origine
              </button>
            )}
          </div>
        </form>
        <section className="panel mail-preview" aria-label="Aperçu avec des données d’exemple">
          <div className="mail-preview-head">
            <span className="muted">Objet</span>
            <strong>{preview?.subject}</strong>
            <span className="muted small">Exemple</span>
          </div>
          {preview && <iframe title={`Aperçu : ${preview.subject}`} srcDoc={preview.html} sandbox="" />}
        </section>
      </div>
    </>
  );
}
