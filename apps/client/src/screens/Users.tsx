import { useCallback, useEffect, useState } from 'react';
import { get, post, put } from '../lib/api';
import { dateFr } from '../lib/types';
import { Banner, Pills, StatusPill } from '../components/ui';

/** ADM-03 : l'administrateur invite, modifie et désactive les utilisateurs de son entreprise et leur attribue des projets. */

type Role = 'B2B_ADMIN' | 'B2B_USER';
interface User {
  id: string;
  nom: string;
  email: string;
  role: Role;
  statut: 'INVITE' | 'ACTIF' | 'DESACTIVE';
  peutCommanderSeul: boolean;
  derniereConnexion: string | null;
  projets: string[];
  invitation: { expireLe: string; expiree: boolean } | null;
}
interface Projet {
  id: string;
  nom: string;
  statut: string;
}
interface List {
  items: User[];
  projets: Projet[];
  moi: string;
  envoiEmails: boolean;
}

const ROLE: Record<Role, string> = { B2B_ADMIN: 'Administrateur', B2B_USER: 'Utilisateur' };
const STATUT: Record<User['statut'], string> = { INVITE: 'Invitation envoyée', ACTIF: 'Actif', DESACTIVE: 'Désactivé' };

interface Draft {
  nom: string;
  email: string;
  role: Role;
  projets: string[];
  peutCommanderSeul: boolean;
}
const EMPTY: Draft = { nom: '', email: '', role: 'B2B_USER', projets: [], peutCommanderSeul: true };

export function Users() {
  const [data, setData] = useState<List | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<{ nom: string; lien: string } | null>(null);
  const [inviting, setInviting] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      get<List>('/me/users')
        .then(setData)
        .catch((e) => setError((e as Error).message)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      setNotice(ok);
      setError(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
      setNotice(null);
    } finally {
      setBusy(false);
    }
  };
  const showLink = (nom: string, r: { lien?: string }) => setLink(r.lien ? { nom, lien: r.lien } : null);

  if (!data) return error ? <Banner kind="error">{error}</Banner> : <p className="hint">Chargement…</p>;
  const actifs = data.items.filter((u) => u.statut !== 'DESACTIVE').length;
  const projName = (id: string) => data.projets.find((p) => p.id === id)?.nom ?? '—';

  return (
    <>
      <section className="page-head with-action">
        <div>
          <span className="eyebrow">— Mon entreprise</span>
          <h1>Utilisateurs</h1>
          <p className="lead">
            {actifs} accès ouvert{actifs > 1 ? 's' : ''}. Un administrateur voit tous les projets et valide les commandes ; un utilisateur ne voit que les projets que vous lui attribuez.
          </p>
        </div>
        {!inviting && (
          <button type="button" className="btn primary" onClick={() => setInviting(true)}>
            Inviter un utilisateur
          </button>
        )}
      </section>

      {notice && <Banner kind="ok">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
      {link && (
        <div className="callout link-callout">
          <strong>Lien d’activation de {link.nom}</strong>
          <p>L’envoi automatique des e-mails n’est pas encore branché : transmettez ce lien vous-même. Il est valable 7 jours et ne sert qu’une fois.</p>
          <div className="copy-row">
            <input readOnly value={link.lien} className="mono" onFocus={(e) => e.target.select()} aria-label="Lien d’activation" />
            <button type="button" className="btn small" onClick={() => void navigator.clipboard?.writeText(link.lien).then(() => setNotice('Lien copié.'))}>
              Copier
            </button>
          </div>
        </div>
      )}

      {inviting && (
        <form
          className="form-card user-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await post<{ lien?: string }>('/me/users', draft);
              showLink(draft.nom, r);
              setInviting(false);
              setDraft(EMPTY);
            }, data.envoiEmails ? `Invitation envoyée à ${draft.email}.` : `Accès créé pour ${draft.nom}.`);
          }}
        >
          <h2>Nouvel utilisateur</h2>
          <div className="two">
            <label>
              Nom et prénom
              <input value={draft.nom} onChange={(e) => setDraft({ ...draft, nom: e.target.value })} required minLength={2} autoFocus />
            </label>
            <label>
              Email professionnel
              <input type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} required />
            </label>
          </div>
          <RoleFields value={draft} onChange={setDraft} projets={data.projets} />
          <div className="row-actions">
            <button type="submit" className="btn primary" disabled={busy || (draft.role === 'B2B_USER' && draft.projets.length === 0)}>
              {busy ? '…' : 'Envoyer l’invitation'}
            </button>
            <button type="button" className="btn" onClick={() => setInviting(false)}>
              Annuler
            </button>
          </div>
          {draft.role === 'B2B_USER' && draft.projets.length === 0 && <p className="hint">Choisissez au moins un projet.</p>}
        </form>
      )}

      <ul className="user-list">
        {data.items.map((u) => (
          <li key={u.id} className={u.statut === 'DESACTIVE' ? 'off' : ''}>
            <div className="user-head">
              <span className="avatar" aria-hidden="true">
                {u.nom
                  .split(/\s+/)
                  .slice(0, 2)
                  .map((w) => w[0])
                  .join('')
                  .toUpperCase()}
              </span>
              <span className="user-main">
                <strong>
                  {u.nom}
                  {u.id === data.moi && <span className="muted"> · vous</span>}
                </strong>
                <span className="muted">{u.email}</span>
              </span>
              <span className="user-role">{ROLE[u.role]}</span>
              <StatusPill label={u.statut === 'INVITE' && u.invitation?.expiree ? 'Invitation expirée' : STATUT[u.statut]} tone={u.statut === 'ACTIF' ? 'neutral' : u.statut === 'INVITE' ? 'accent' : 'dark'} />
            </div>
            <div className="user-meta">
              <span>{u.role === 'B2B_ADMIN' ? 'Tous les projets' : u.projets.length ? u.projets.map(projName).join(' · ') : 'Aucun projet'}</span>
              {u.role === 'B2B_USER' && !u.peutCommanderSeul && <span>Commandes soumises à validation</span>}
              <span>
                {u.statut === 'INVITE' && u.invitation
                  ? u.invitation.expiree
                    ? 'Lien expiré'
                    : `Lien valable jusqu’au ${dateFr(u.invitation.expireLe)}`
                  : u.derniereConnexion
                    ? `Dernière connexion le ${dateFr(u.derniereConnexion)}`
                    : 'Jamais connecté'}
              </span>
            </div>

            {editing === u.id ? (
              <form
                className="user-edit"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(async () => {
                    await put(`/me/users/${u.id}`, { nom: edit.nom, role: edit.role, projets: edit.projets, peutCommanderSeul: edit.peutCommanderSeul });
                    setEditing(null);
                  }, `${edit.nom} : modifications enregistrées.`);
                }}
              >
                <label>
                  Nom et prénom
                  <input value={edit.nom} onChange={(e) => setEdit({ ...edit, nom: e.target.value })} required minLength={2} />
                </label>
                <RoleFields value={edit} onChange={setEdit} projets={data.projets} />
                <div className="row-actions">
                  <button type="submit" className="btn primary small" disabled={busy}>
                    Enregistrer
                  </button>
                  <button type="button" className="btn small" onClick={() => setEditing(null)}>
                    Annuler
                  </button>
                </div>
              </form>
            ) : (
              <div className="row-actions">
                {u.statut !== 'DESACTIVE' && (
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      setEditing(u.id);
                      setEdit({ nom: u.nom, email: u.email, role: u.role, projets: u.projets, peutCommanderSeul: u.peutCommanderSeul });
                    }}
                  >
                    Modifier
                  </button>
                )}
                {u.statut === 'INVITE' && (
                  <button type="button" className="btn small" disabled={busy} onClick={() => void run(async () => showLink(u.nom, await post<{ lien?: string }>(`/me/users/${u.id}/invite`)), data.envoiEmails ? `Nouvelle invitation envoyée à ${u.email}.` : `Nouveau lien créé pour ${u.nom}.`)}>
                    Renvoyer l’invitation
                  </button>
                )}
                {u.statut !== 'DESACTIVE' && u.id !== data.moi && (
                  <button
                    type="button"
                    className="btn small danger"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Désactiver l’accès de ${u.nom} ? Sa session est coupée immédiatement.`)) void run(() => post(`/me/users/${u.id}/deactivate`), `${u.nom} n’a plus accès à l’Espace Client.`);
                    }}
                  >
                    Désactiver
                  </button>
                )}
                {u.statut === 'DESACTIVE' && (
                  <button type="button" className="btn small" disabled={busy} onClick={() => void run(async () => showLink(u.nom, await post<{ lien?: string }>(`/me/users/${u.id}/reactivate`)), `${u.nom} a de nouveau accès.`)}>
                    Réactiver
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function RoleFields({ value, onChange, projets }: { value: Draft; onChange: (d: Draft) => void; projets: Projet[] }) {
  const toggle = (id: string) => onChange({ ...value, projets: value.projets.includes(id) ? value.projets.filter((p) => p !== id) : [...value.projets, id] });
  return (
    <>
      <Pills<Role>
        label="Rôle"
        value={value.role}
        onChange={(role) => onChange({ ...value, role })}
        options={[
          { value: 'B2B_USER', label: 'Utilisateur' },
          { value: 'B2B_ADMIN', label: 'Administrateur' },
        ]}
      />
      {value.role === 'B2B_USER' ? (
        <fieldset className="constraints">
          <legend>Projets visibles</legend>
          {projets.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={value.projets.includes(p.id)} onChange={() => toggle(p.id)} /> {p.nom}
              {p.statut !== 'ACTIF' && <span className="muted"> · {p.statut.toLowerCase()}</span>}
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={!value.peutCommanderSeul} onChange={(e) => onChange({ ...value, peutCommanderSeul: !e.target.checked })} /> Ses commandes passent par votre validation
          </label>
        </fieldset>
      ) : (
        <p className="hint">Un administrateur voit tous les projets, valide les commandes, gère les utilisateurs et la facturation.</p>
      )}
    </>
  );
}
