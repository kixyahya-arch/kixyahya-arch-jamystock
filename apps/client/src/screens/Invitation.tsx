import { useEffect, useState } from 'react';
import { acceptInvitation, ApiError, publicGet, type Session } from '../lib/api';
import { Banner } from '../components/ui';
import { BrandLogo } from '../components/Brand';

/** ADM-03 : activation d'un accès à partir du lien reçu par e-mail (valable 7 jours, à usage unique). */
export function Invitation({ token, onLogged }: { token: string; onLogged: (s: Session) => void }) {
  const [info, setInfo] = useState<{ email: string; nom: string; entreprise: string | null } | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    publicGet<{ email: string; nom: string; entreprise: string | null }>(`/auth/invitation/${encodeURIComponent(token)}`)
      .then(setInfo)
      .catch((e) => setInvalid((e as Error).message));
  }, [token]);

  const strong = password.length >= 10 && /[A-Za-z]/.test(password) && /\d/.test(password);

  return (
    <div className="login">
      <div className="login-brand">
        <h1 className="sr-only">JAMYSTOCK</h1>
        <BrandLogo variant="blanc" size={64} />
        <span>{info ? `Bienvenue, ${info.nom}.` : 'Activez votre accès.'}</span>
      </div>
      {invalid ? (
        <>
          <Banner kind="error">{invalid}</Banner>
          <a className="btn primary big" href="#/">
            Aller à la connexion
          </a>
        </>
      ) : !info ? (
        <p className="hint">Vérification du lien…</p>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (password !== confirm) {
              setError('Les deux mots de passe ne sont pas identiques.');
              return;
            }
            setBusy(true);
            setError(null);
            try {
              const s = await acceptInvitation(token, password);
              window.location.hash = '#/';
              onLogged(s);
            } catch (err) {
              setError(err instanceof ApiError ? err.message : 'Connexion impossible : vérifiez votre réseau.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="invite-intro">
            Votre accès à l’Espace Client{info.entreprise ? <> de <strong>{info.entreprise}</strong></> : null} est prêt. Choisissez votre mot de passe pour l’activer.
          </p>
          <label>
            Email
            <input type="email" value={info.email} readOnly autoComplete="username" />
          </label>
          <label>
            Mot de passe
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoFocus />
            <small className={`pw-rule ${strong ? 'ok' : ''}`}>10 caractères au moins, avec une lettre et un chiffre</small>
          </label>
          <label>
            Confirmer le mot de passe
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </label>
          {error && <Banner kind="error">{error}</Banner>}
          <button className="btn primary big" disabled={busy || !strong}>
            {busy ? 'Activation…' : 'Activer mon accès'}
          </button>
        </form>
      )}
    </div>
  );
}
