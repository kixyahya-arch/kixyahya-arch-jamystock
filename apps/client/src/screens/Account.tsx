import { useCallback, useEffect, useState } from 'react';
import { get, post, put, type Session } from '../lib/api';
import { hashParam } from '../lib/router';
import { Banner } from '../components/ui';

/** ADM-04 (informations de facturation, moyen de paiement) et §6.3 (préférences de notification). */

interface Billing {
  nom: string;
  type: 'B2B' | 'B2C';
  siret: string | null;
  tvaIntracom: string | null;
  adresseFacturation: string | null;
  emailFacturation: string | null;
  bonDeCommande: string | null;
  conditionsPaiement: string | null;
  moyenPaiement: 'CARTE' | 'SEPA' | 'VIREMENT' | null;
  moyenDetail: { type: 'CARTE' | 'SEPA'; marque?: string; derniers4: string; expire?: string } | null;
  paiementEnLigne: boolean;
  moyensProposes: ('CARTE' | 'SEPA' | 'VIREMENT')[];
  virement: { titulaire: string; iban: string; bic: string | null } | null;
}
interface Pref {
  modele: string;
  libelle: string;
  email: boolean;
}

const BRAND: Record<string, string> = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', cartes_bancaires: 'CB' };

export function Account({ session }: { session: Session }) {
  const role = session.user?.role ?? '';
  const holder = role === 'B2B_ADMIN' || role === 'B2C';
  const [billing, setBilling] = useState<Billing | null>(null);
  const [form, setForm] = useState({ adresseFacturation: '', emailFacturation: '', bonDeCommande: '', siret: '', tvaIntracom: '' });
  const [prefs, setPrefs] = useState<Pref[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadBilling = useCallback(async () => {
    if (!holder) return;
    const b = await get<Billing>('/me/billing');
    setBilling(b);
    setForm({ adresseFacturation: b.adresseFacturation ?? '', emailFacturation: b.emailFacturation ?? '', bonDeCommande: b.bonDeCommande ?? '', siret: b.siret ?? '', tvaIntracom: b.tvaIntracom ?? '' });
  }, [holder]);

  useEffect(() => {
    loadBilling().catch((e) => setError((e as Error).message));
    get<{ items: Pref[] }>('/me/preferences')
      .then((r) => setPrefs(r.items))
      .catch((e) => setError((e as Error).message));
    // retour de la page Stripe : le webhook peut arriver quelques secondes après
    const back = hashParam('paiement');
    if (back === 'enregistre') {
      setNotice('Moyen de paiement transmis à Stripe : il apparaît ici dès que la banque l’a confirmé.');
      const timer = setTimeout(() => void loadBilling().catch(() => undefined), 3000);
      return () => clearTimeout(timer);
    }
    if (back === 'annule') setNotice('Enregistrement annulé : aucun moyen de paiement n’a été modifié.');
    return undefined;
  }, [loadBilling]);

  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) setNotice(ok);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setNotice(null);
    } finally {
      setBusy(null);
    }
  };

  const openStripe = (type: 'CARTE' | 'SEPA') =>
    act('stripe', async () => {
      const r = await post<{ url: string }>('/me/billing/payment-method', { type });
      window.location.assign(r.url);
    });

  const b2b = billing?.type === 'B2B';

  return (
    <>
      <section className="page-head">
        <span className="eyebrow">— Mon compte</span>
        <h1>{session.user?.nom}</h1>
        <p className="lead">
          {session.user?.email}
          {billing ? ` · ${billing.nom}` : ''}
        </p>
      </section>
      {notice && <Banner kind="ok">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}

      <div className="account-grid">
        {holder && billing && (
          <>
            <section className="form-card">
              <h2>Moyen de paiement</h2>
              <PaymentSummary b={billing} />
              {!billing.paiementEnLigne ? (
                <p className="hint">
                  Le paiement en ligne n’est pas encore activé sur votre espace.{' '}
                  {b2b ? 'Vos factures se règlent par virement.' : 'Nous vous contacterons pour enregistrer votre carte.'}
                </p>
              ) : (
                <div className="row-actions">
                  {billing.moyensProposes.includes('CARTE') && (
                    <button type="button" className="btn primary" disabled={!!busy} onClick={() => void openStripe('CARTE')}>
                      {busy === 'stripe' ? 'Ouverture…' : billing.moyenDetail?.type === 'CARTE' ? 'Changer de carte' : 'Enregistrer ma carte'}
                    </button>
                  )}
                  {billing.moyensProposes.includes('SEPA') && (
                    <button type="button" className={billing.moyenPaiement === 'SEPA' ? 'btn' : 'btn primary'} disabled={!!busy} onClick={() => void openStripe('SEPA')}>
                      {busy === 'stripe' ? 'Ouverture…' : billing.moyenDetail?.type === 'SEPA' ? 'Changer de compte bancaire' : 'Mettre en place le prélèvement SEPA'}
                    </button>
                  )}
                </div>
              )}
              {b2b && (
                <div className="pay-choice" role="radiogroup" aria-label="Règlement des factures">
                  <label className="check">
                    <input
                      type="radio"
                      name="moyen"
                      checked={billing.moyenPaiement === 'SEPA'}
                      disabled={billing.moyenDetail?.type !== 'SEPA' || !!busy}
                      onChange={() => void act('moyen', () => put('/me/billing', { moyenPaiement: 'SEPA' }).then(loadBilling), 'Les prochaines factures seront prélevées automatiquement.')}
                    />
                    Prélèvement SEPA automatique{billing.moyenDetail?.type !== 'SEPA' ? ' (mandat à mettre en place)' : ''}
                  </label>
                  <label className="check">
                    <input
                      type="radio"
                      name="moyen"
                      checked={billing.moyenPaiement !== 'SEPA'}
                      disabled={!!busy}
                      onChange={() => void act('moyen', () => put('/me/billing', { moyenPaiement: 'VIREMENT' }).then(loadBilling), 'Vos factures se règlent désormais par virement.')}
                    />
                    Virement à réception de facture{billing.conditionsPaiement ? ` (${billing.conditionsPaiement})` : ''}
                  </label>
                </div>
              )}
              {b2b && billing.moyenPaiement !== 'SEPA' && billing.virement && (
                <dl className="facts bank">
                  <dt>Titulaire</dt>
                  <dd>{billing.virement.titulaire}</dd>
                  <dt>IBAN</dt>
                  <dd className="mono">{billing.virement.iban}</dd>
                  {billing.virement.bic && (
                    <>
                      <dt>BIC</dt>
                      <dd className="mono">{billing.virement.bic}</dd>
                    </>
                  )}
                </dl>
              )}
              <p className="hint small">Vos coordonnées bancaires sont saisies sur la page sécurisée de Stripe : JAMYSTOCK ne conserve que la marque et les 4 derniers chiffres.</p>
            </section>

            <form
              className="form-card"
              onSubmit={(e) => {
                e.preventDefault();
                void act(
                  'billing',
                  () =>
                    put('/me/billing', {
                      adresseFacturation: form.adresseFacturation || null,
                      emailFacturation: form.emailFacturation || null,
                      ...(b2b ? { bonDeCommande: form.bonDeCommande || null } : {}),
                      // SIRET et TVA ne sont renvoyés (et contrôlés) que s'ils ont été modifiés
                      ...(b2b && form.siret !== (billing.siret ?? '') ? { siret: form.siret || null } : {}),
                      ...(b2b && form.tvaIntracom !== (billing.tvaIntracom ?? '') ? { tvaIntracom: form.tvaIntracom || null } : {}),
                    }).then(loadBilling),
                  'Informations de facturation enregistrées.',
                );
              }}
            >
              <h2>Informations de facturation</h2>
              <label>
                Adresse de facturation
                <textarea rows={2} value={form.adresseFacturation} onChange={(e) => setForm({ ...form, adresseFacturation: e.target.value })} />
              </label>
              <label>
                Email qui reçoit les factures <small>(facultatif)</small>
                <input type="email" value={form.emailFacturation} onChange={(e) => setForm({ ...form, emailFacturation: e.target.value })} placeholder="compta@votre-entreprise.fr" />
              </label>
              {b2b && (
                <>
                  <label>
                    Bon de commande à rappeler sur les factures <small>(facultatif)</small>
                    <input value={form.bonDeCommande} onChange={(e) => setForm({ ...form, bonDeCommande: e.target.value })} placeholder="PO-2026-117" className="mono" />
                  </label>
                  <div className="two">
                    <label>
                      SIRET
                      <input value={form.siret} onChange={(e) => setForm({ ...form, siret: e.target.value })} inputMode="numeric" className="mono" />
                    </label>
                    <label>
                      TVA intracommunautaire
                      <input value={form.tvaIntracom} onChange={(e) => setForm({ ...form, tvaIntracom: e.target.value })} className="mono" />
                    </label>
                  </div>
                </>
              )}
              <button type="submit" className="btn primary" disabled={!!busy}>
                {busy === 'billing' ? 'Enregistrement…' : 'Enregistrer'}
              </button>
            </form>
          </>
        )}

        <section className="form-card">
          <h2>Notifications par e-mail</h2>
          {!prefs ? (
            <p className="hint">Chargement…</p>
          ) : (
            <>
              {prefs.map((p) => (
                <label key={p.modele} className="check">
                  <input
                    type="checkbox"
                    checked={p.email}
                    disabled={busy === p.modele}
                    onChange={(e) => {
                      const v = e.target.checked;
                      void act(p.modele, async () => {
                        await put('/me/preferences', { [p.modele]: v });
                        setPrefs(prefs.map((x) => (x.modele === p.modele ? { ...x, email: v } : x)));
                      });
                    }}
                  />
                  {p.libelle}
                </label>
              ))}
              <p className="hint small">Les invitations, bons de livraison, factures et avis de paiement sont toujours envoyés.</p>
            </>
          )}
        </section>
      </div>
    </>
  );
}

function PaymentSummary({ b }: { b: Billing }) {
  const d = b.moyenDetail;
  if (b.moyenPaiement === 'CARTE' && d)
    return (
      <p className="pay-current">
        <span className="pay-badge">{BRAND[d.marque ?? ''] ?? d.marque ?? 'Carte'}</span> •••• {d.derniers4}
        {d.expire && <span className="muted"> · expire fin {d.expire}</span>}
        <span className="muted"> · prélevée à chaque facture</span>
      </p>
    );
  if (b.moyenPaiement === 'SEPA' && d)
    return (
      <p className="pay-current">
        <span className="pay-badge">SEPA</span> Compte •••• {d.derniers4}
        <span className="muted"> · prélèvement à chaque facture</span>
      </p>
    );
  if (b.moyenPaiement === 'VIREMENT') return <p className="pay-current">Virement à réception de facture</p>;
  return <p className="pay-current muted">{b.type === 'B2C' ? 'Aucune carte enregistrée : elle est nécessaire pour le prélèvement mensuel.' : 'Aucun moyen de paiement choisi : vos factures se règlent par virement.'}</p>;
}
