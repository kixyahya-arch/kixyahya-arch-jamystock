import { useCallback, useEffect, useState } from 'react';
import { get, getSession, post } from '../lib/api';
import { go, href } from '../lib/router';
import type { ClientDetail, ClientRow } from '../lib/types';
import { ROLE, USER_STATUS, dateFr, euros } from '../lib/labels';
import { Banner, Pills, StatusPill } from '../components/ui';

const m2 = (n: number | null | undefined) => (n ?? 0).toLocaleString('fr-FR', { maximumFractionDigits: 1 });

function Meter({ taux, niveau }: { taux: number | null; niveau: string | null }) {
  if (taux === null) return <span className="muted">Sans forfait</span>;
  return (
    <span className={`meter ${niveau?.toLowerCase() ?? ''}`} title={`${taux} % du forfait`}>
      <span style={{ width: `${Math.min(taux, 100)}%` }} />
    </span>
  );
}

export function Clients({ canCreate }: { canCreate: boolean }) {
  const [items, setItems] = useState<ClientRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'' | 'B2B' | 'B2C'>('');
  const [q, setQ] = useState('');

  useEffect(() => {
    get<{ items: ClientRow[] }>('/bo/clients')
      .then((r) => setItems(r.items))
      .catch((e) => setError((e as Error).message));
  }, []);

  const shown = (items ?? []).filter((c) => (!filter || c.type === filter) && (!q.trim() || c.nom.toLowerCase().includes(q.trim().toLowerCase())));

  return (
    <>
      <section className="bo-head">
        <div>
          <p className="eyebrow">— Comptes</p>
          <h1>Clients</h1>
        </div>
        {canCreate && (
          <a className="btn primary" href={href({ name: 'nouveau-client' })}>
            Ouvrir un compte client
          </a>
        )}
      </section>
      <section className="toolbar">
        <Pills
          label="Type de client"
          value={filter}
          onChange={setFilter}
          options={[
            { value: '', label: 'Tous' },
            { value: 'B2B', label: 'Professionnels' },
            { value: 'B2C', label: 'Particuliers' },
          ]}
        />
        <input className="search" type="search" placeholder="Nom du client…" aria-label="Rechercher un client" value={q} onChange={(e) => setQ(e.target.value)} />
      </section>
      {error && <Banner kind="error">{error}</Banner>}
      {!items ? (
        !error && <p className="hint">Chargement…</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Type</th>
                <th className="num">Biens</th>
                <th>Surface</th>
                <th className="num">Projets</th>
                <th className="num">Demandes en cours</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id}>
                  <td>
                    <a href={href({ name: 'client', id: c.id })}>
                      <strong>{c.nom}</strong>
                    </a>
                    {c.siret && <div className="muted mono">{c.siret}</div>}
                  </td>
                  <td>{c.type === 'B2B' ? 'Professionnel' : 'Particulier'}</td>
                  <td className="num">{c.nbArticles}</td>
                  <td>
                    <div className="surface-cell">
                      <span>
                        {m2(c.m2Occupes)} m²{c.m2Inclus ? ` / ${m2(c.m2Inclus)}` : ''}
                      </span>
                      <Meter taux={c.taux} niveau={c.niveau} />
                    </div>
                  </td>
                  <td className="num">{c.type === 'B2B' ? c.nbProjets : '—'}</td>
                  <td className="num">{c.demandesEnCours}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export function ClientView({ id }: { id: string }) {
  const [c, setC] = useState<ClientDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projet, setProjet] = useState('');
  const canEdit = getSession()?.user?.role === 'SUPER_ADMIN';

  const load = useCallback(() => {
    get<ClientDetail>(`/bo/clients/${id}`)
      .then(setC)
      .catch((e) => setError((e as Error).message));
  }, [id]);
  useEffect(load, [load]);

  if (error && !c) return <Banner kind="error">{error}</Banner>;
  if (!c) return <p className="hint">Chargement…</p>;
  const f = c.forfait;

  return (
    <>
      <a className="back-link" href={href({ name: 'clients' })}>
        ← Tous les clients
      </a>
      <section className="bo-head">
        <div>
          <p className="eyebrow">— {c.type === 'B2B' ? 'Client professionnel' : 'Client particulier'}</p>
          <h1>{c.nom}</h1>
          <p className="lead">Client depuis le {dateFr(c.creeLe)}</p>
        </div>
      </section>
      {error && <Banner kind="error">{error}</Banner>}

      <section className="tiles" aria-label="Surface">
        <div className="tile accent">
          <strong>{m2(c.surface.m2Occupes)} m²</strong>
          <span>occupés{c.surface.m2Inclus ? ` sur ${m2(c.surface.m2Inclus)} m² inclus` : ''}</span>
        </div>
        <div className="tile">
          <strong>{c.surface.taux === null ? '—' : `${c.surface.taux} %`}</strong>
          <span>du forfait</span>
        </div>
        <div className="tile">
          <strong>{c.surface.nbArticles}</strong>
          <span>biens au dépôt</span>
        </div>
      </section>

      <div className="two-col">
        <div className="col-main">
          {c.type === 'B2B' && (
            <section className="panel">
              <h2>Projets</h2>
              {c.projets.length === 0 && <p className="hint">Aucun projet.</p>}
              <ul className="plain">
                {c.projets.map((p) => {
                  const s = c.surface.parProjet.find((x) => x.projetId === p.id);
                  return (
                    <li key={p.id}>
                      <strong>{p.nom}</strong>
                      <span className="muted">
                        {p.nbArticles} bien{p.nbArticles > 1 ? 's' : ''}
                        {s ? ` · ${m2(s.m2)} m²` : ''}
                        {p.statut !== 'ACTIF' ? ` · ${p.statut.toLowerCase()}` : ''}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {canEdit && (
                <form
                  className="row inline-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      await post(`/bo/clients/${c.id}/projets`, { nom: projet });
                      setProjet('');
                      load();
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                >
                  <input aria-label="Nom du nouveau projet" placeholder="Nom du nouveau projet" value={projet} onChange={(e) => setProjet(e.target.value)} minLength={2} required />
                  <button className="btn small">Ajouter le projet</button>
                </form>
              )}
            </section>
          )}

          <section className="panel">
            <h2>Utilisateurs</h2>
            <table className="table compact">
              <tbody>
                {c.utilisateurs.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.nom}</strong>
                      <div className="muted">{u.email}</div>
                    </td>
                    <td>{ROLE[u.role] ?? u.role}</td>
                    <td>
                      <StatusPill label={USER_STATUS[u.statut] ?? u.statut} tone={u.statut === 'INVITE' ? 'lime' : u.statut === 'DESACTIVE' ? 'alert' : 'neutral'} />
                    </td>
                    <td className="muted">{u.derniereConnexion ? `Vu le ${dateFr(u.derniereConnexion)}` : 'Jamais connecté'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>

        <aside className="col-side">
          <section className="panel">
            <h2>Forfait</h2>
            {f ? (
              <dl className="facts">
                <dt>Surface incluse</dt>
                <dd>{m2(f.m2Inclus)} m²</dd>
                <dt>Abonnement</dt>
                <dd>{euros(f.prixMensuelCents)} HT / mois</dd>
                <dt>Dépassement</dt>
                <dd>{euros(f.prixM2DepassementCents)} HT / m²</dd>
                <dt>Livraisons incluses</dt>
                <dd>{f.prestationsIncluses.LIVRAISON ?? 0} par mois</dd>
                <dt>Depuis le</dt>
                <dd>
                  {dateFr(f.dateDebut)}
                  {f.engagementMois ? ` · engagement ${f.engagementMois} mois` : ''}
                </dd>
                <dt>Grille</dt>
                <dd>{f.grille}</dd>
              </dl>
            ) : (
              <p className="hint">Pas de forfait : tarif de la grille standard.</p>
            )}
          </section>
          <section className="panel">
            <h2>Facturation</h2>
            <dl className="facts">
              <dt>SIRET</dt>
              <dd className="mono">{c.siret ?? '—'}</dd>
              <dt>TVA intracom.</dt>
              <dd className="mono">{c.tvaIntracom ?? '—'}</dd>
              <dt>Adresse</dt>
              <dd>{c.adresseFacturation?.libelle ?? '—'}</dd>
              <dt>Paiement</dt>
              <dd>{c.conditionsPaiement ?? '—'}</dd>
            </dl>
          </section>
        </aside>
      </div>
    </>
  );
}

/** CLI-01 : ouverture d'un compte client, avec son contact principal, ses projets et son forfait. */
export function NewClient() {
  const [type, setType] = useState<'B2B' | 'B2C'>('B2B');
  const [form, setForm] = useState({
    nom: '',
    siret: '',
    tva: '',
    adresse: '',
    paiement: 'Virement à 30 jours',
    contactNom: '',
    contactEmail: '',
    contactTel: '',
    projets: '',
    forfait: true,
    m2: '50',
    mensuel: '750',
    depassement: '18',
    livraisons: '2',
    engagement: '12',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const cents = (s: string) => Math.round(Number(s.replace(',', '.')) * 100);

  return (
    <>
      <a className="back-link" href={href({ name: 'clients' })}>
        ← Tous les clients
      </a>
      <section className="bo-head">
        <div>
          <p className="eyebrow">— Nouveau compte</p>
          <h1>Ouvrir un compte client</h1>
        </div>
      </section>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await post<{ id: string }>('/bo/clients', {
              type,
              nom: form.nom,
              ...(form.siret ? { siret: form.siret } : {}),
              ...(form.tva ? { tvaIntracom: form.tva } : {}),
              ...(form.adresse ? { adresseFacturation: { libelle: form.adresse } } : {}),
              ...(form.paiement ? { conditionsPaiement: form.paiement } : {}),
              contact: { nom: form.contactNom, email: form.contactEmail, ...(form.contactTel ? { telephone: form.contactTel } : {}) },
              projets: type === 'B2B' ? form.projets.split('\n').map((s) => s.trim()).filter(Boolean) : [],
              ...(form.forfait
                ? {
                    forfait: {
                      m2Inclus: Number(form.m2.replace(',', '.')),
                      prixMensuelCents: cents(form.mensuel),
                      prixM2DepassementCents: cents(form.depassement),
                      livraisonsIncluses: Number(form.livraisons) || 0,
                      ...(form.engagement ? { engagementMois: Number(form.engagement) } : {}),
                    },
                  }
                : {}),
            });
            go({ name: 'client', id: r.id });
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <section className="panel">
          <h2>Client</h2>
          <Pills
            label="Type de client"
            value={type}
            onChange={setType}
            options={[
              { value: 'B2B', label: 'Professionnel' },
              { value: 'B2C', label: 'Particulier' },
            ]}
          />
          <label>
            {type === 'B2B' ? 'Raison sociale' : 'Nom et prénom'}
            <input value={form.nom} onChange={set('nom')} required minLength={2} />
          </label>
          {type === 'B2B' && (
            <div className="row">
              <label>
                SIRET
                <input value={form.siret} onChange={set('siret')} required inputMode="numeric" placeholder="14 chiffres" />
              </label>
              <label>
                TVA intracommunautaire
                <input value={form.tva} onChange={set('tva')} placeholder="FR…" />
              </label>
            </div>
          )}
          <label>
            Adresse de facturation
            <input value={form.adresse} onChange={set('adresse')} />
          </label>
          <label>
            Conditions de paiement
            <input value={form.paiement} onChange={set('paiement')} />
          </label>
        </section>

        <section className="panel">
          <h2>Contact principal</h2>
          <p className="hint">Il recevra l’invitation à créer son mot de passe quand l’envoi des emails sera branché.</p>
          <label>
            Nom
            <input value={form.contactNom} onChange={set('contactNom')} required minLength={2} />
          </label>
          <div className="row">
            <label>
              Email
              <input type="email" value={form.contactEmail} onChange={set('contactEmail')} required />
            </label>
            <label>
              Téléphone
              <input type="tel" value={form.contactTel} onChange={set('contactTel')} />
            </label>
          </div>
          {type === 'B2B' && (
            <label>
              Projets (un par ligne)
              <textarea rows={3} value={form.projets} onChange={set('projets')} placeholder={'Résidence Les Oliviers\nBureau de vente Les Pins'} />
            </label>
          )}
        </section>

        <section className="panel">
          <h2>Forfait</h2>
          <label className="inline check">
            <input type="checkbox" checked={form.forfait} onChange={(e) => setForm({ ...form, forfait: e.target.checked })} /> Forfait sur-mesure
          </label>
          {form.forfait && (
            <>
              <div className="row">
                <label>
                  Surface incluse (m²)
                  <input inputMode="decimal" value={form.m2} onChange={set('m2')} required />
                </label>
                <label>
                  Abonnement (€ HT / mois)
                  <input inputMode="decimal" value={form.mensuel} onChange={set('mensuel')} required />
                </label>
              </div>
              <div className="row">
                <label>
                  Dépassement (€ HT / m²)
                  <input inputMode="decimal" value={form.depassement} onChange={set('depassement')} required />
                </label>
                <label>
                  Livraisons incluses / mois
                  <input inputMode="numeric" value={form.livraisons} onChange={set('livraisons')} />
                </label>
                <label>
                  Engagement (mois)
                  <input inputMode="numeric" value={form.engagement} onChange={set('engagement')} />
                </label>
              </div>
            </>
          )}
        </section>

        {error && <Banner kind="error">{error}</Banner>}
        <div className="row-actions">
          <button className="btn primary big" disabled={busy}>
            {busy ? 'Création…' : 'Créer le compte'}
          </button>
        </div>
      </form>
    </>
  );
}
