import { useState } from 'react';
import { ApiError, login, NetworkError, type Session } from '../lib/api';
import { Banner } from '../components/ui';

export function Login({ onLogged }: { onLogged: (s: Session) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfa, setMfa] = useState('');
  const [needMfa, setNeedMfa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="login">
      <div className="login-brand">
        <strong>jamystock</strong>
        <span>Votre stock, objet par objet.</span>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            onLogged(await login(email, password, needMfa ? mfa : undefined));
          } catch (err) {
            if (err instanceof ApiError && err.code === 'MFA_REQUIRED') setNeedMfa(true);
            else setError(err instanceof NetworkError ? 'Connexion impossible : vérifiez votre réseau.' : (err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Mot de passe
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {needMfa && (
          <label>
            Code de vérification
            <input inputMode="numeric" pattern="\d{6}" value={mfa} onChange={(e) => setMfa(e.target.value)} required autoFocus />
          </label>
        )}
        {error && <Banner kind="error">{error}</Banner>}
        <button className="btn primary big" disabled={busy}>
          {busy ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
    </div>
  );
}
