import { useEffect, useState } from 'react';
import { get, post } from '../lib/api';
import { dateFr } from '../lib/labels';
import { Banner, Pills, StatusPill, Tile } from '../components/ui';

/** §6.3 : suivi des e-mails envoyés aux clients (invitations, commandes, livraisons, factures, paiements). */

type Statut = '' | 'EN_ATTENTE' | 'ENVOYEE' | 'ECHEC' | 'IGNOREE';
interface Mail {
  id: string;
  modele: string;
  statut: Exclude<Statut, ''>;
  objet: string | null;
  fournisseur: string | null;
  erreur: string | null;
  tentatives: number;
  creeLe: string;
  envoyeeLe: string | null;
  destinataire: string | null;
  destinataireNom: string | null;
  entreprise: string | null;
}
interface List {
  items: Mail[];
  compteurs: Partial<Record<Exclude<Statut, ''>, number>>;
  fournisseur: 'BREVO' | 'JOURNAL';
}

const MODELE: Record<string, string> = {
  INVITATION: 'Invitation',
  COMMANDE_SOUMISE: 'Commande reçue',
  VALIDATION_REQUISE: 'Validation requise',
  VALIDATION_ACCORDEE: 'Validation accordée',
  VALIDATION_REFUSEE: 'Validation refusée',
  CRENEAU_CONFIRME: 'Créneau confirmé',
  CRENEAU_CONTRE_PROPOSE: 'Contre-proposition',
  CHAUFFEUR_EN_ROUTE: 'Chauffeur en route',
  LIVRAISON_EFFECTUEE: 'Livraison effectuée',
  ARTICLES_MIS_EN_STOCK: 'Mise en stock',
  FACTURE_EMISE: 'Facture émise',
  PAIEMENT_ECHOUE: 'Paiement refusé',
  PAIEMENT_RECU: 'Paiement reçu',
  RELANCE_IMPAYE: 'Relance impayé',
  EXPORT_PRET: 'Export d’inventaire prêt',
  PHOTO_PRETE: 'Photo ou constat prêt',
};
const STATUT: Record<Exclude<Statut, ''>, string> = { EN_ATTENTE: 'En file', ENVOYEE: 'Envoyé', ECHEC: 'Échec', IGNOREE: 'Non envoyé' };
const timeFr = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });

export function Emails() {
  const [data, setData] = useState<List | null>(null);
  const [statut, setStatut] = useState<Statut>('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<{ id: string; subject: string; html: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const p = new URLSearchParams();
    if (statut) p.set('statut', statut);
    if (q.trim()) p.set('q', q.trim());
    const t = setTimeout(() => {
      get<List>(`/bo/emails?${p}`)
        .then((r) => {
          setData(r);
          setError(null);
        })
        .catch((e) => setError((e as Error).message));
    }, 200);
    return () => clearTimeout(t);
  }, [statut, q, reload]);

  const preview = async (m: Mail) => {
    if (open?.id === m.id) return setOpen(null);
    try {
      const r = await get<{ subject: string; html: string }>(`/bo/emails/${m.id}`);
      setOpen({ id: m.id, ...r });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const c = data?.compteurs ?? {};
  return (
    <>
      <section className="bo-head">
        <div>
          <p className="eyebrow">— Clients</p>
          <h1>E-mails</h1>
          <p className="lead">Invitations, suivi des commandes, livraisons, factures et paiements : chaque message envoyé aux clients, avec son aperçu.</p>
        </div>
      </section>

      {data?.fournisseur === 'JOURNAL' && (
        <Banner kind="info">
          Aucun service d’envoi n’est configuré : les messages sont préparés et visibles ici, mais ne partent pas. Ajoutez la clé BREVO_API_KEY (et MAIL_FROM) dans les réglages de l’hébergement pour les
          envoyer.
        </Banner>
      )}
      <section className="tiles" aria-label="E-mails par statut">
        <Tile n={c.ENVOYEE ?? 0} label={data?.fournisseur === 'JOURNAL' ? 'préparés (non envoyés)' : 'envoyés'} onClick={() => setStatut('ENVOYEE')} />
        <Tile n={c.EN_ATTENTE ?? 0} label="en file" accent={(c.EN_ATTENTE ?? 0) > 0} onClick={() => setStatut('EN_ATTENTE')} />
        <Tile n={c.ECHEC ?? 0} label="en échec" alert={(c.ECHEC ?? 0) > 0} onClick={() => setStatut('ECHEC')} />
        <Tile n={c.IGNOREE ?? 0} label="non envoyés (compte désactivé, préférence)" onClick={() => setStatut('IGNOREE')} />
      </section>
      {notice && <Banner kind="ok">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}

      <section className="toolbar" aria-label="Filtres">
        <Pills<Statut>
          label="Statut"
          value={statut}
          onChange={setStatut}
          options={[
            { value: '', label: 'Tous' },
            { value: 'ENVOYEE', label: 'Envoyés' },
            { value: 'EN_ATTENTE', label: 'En file' },
            { value: 'ECHEC', label: 'Échecs' },
            { value: 'IGNOREE', label: 'Non envoyés' },
          ]}
        />
        <input className="search" type="search" placeholder="Adresse, objet ou client…" aria-label="Rechercher un e-mail" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="spacer" />
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await post<{ envoyes: number; ignores: number; erreurs: number }>('/bo/emails/flush');
              setNotice(r.envoyes + r.ignores + r.erreurs === 0 ? 'La file était vide.' : `File traitée : ${r.envoyes} envoyé(s), ${r.ignores} non envoyé(s), ${r.erreurs} en erreur.`);
              setReload((n) => n + 1);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Traiter la file maintenant
        </button>
      </section>

      {open && (
        <section className="panel mail-preview" aria-label="Aperçu de l’e-mail">
          <div className="mail-preview-head">
            <span className="muted">Objet</span>
            <strong>{open.subject}</strong>
            <button type="button" className="btn small" onClick={() => setOpen(null)}>
              Fermer
            </button>
          </div>
          <iframe title={`Aperçu : ${open.subject}`} srcDoc={open.html} sandbox="" />
        </section>
      )}

      {!data ? (
        !error && <p className="hint">Chargement…</p>
      ) : data.items.length === 0 ? (
        <p className="empty">Aucun e-mail pour ces critères.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Destinataire</th>
                <th>Message</th>
                <th>Statut</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data.items.map((m) => (
                <tr key={m.id} className={open?.id === m.id ? 'selected' : ''}>
                  <td className="nowrap">
                    {dateFr(m.envoyeeLe ?? m.creeLe)}
                    <div className="muted">{timeFr(m.envoyeeLe ?? m.creeLe)}</div>
                  </td>
                  <td>
                    <strong>{m.destinataireNom ?? m.destinataire ?? '—'}</strong>
                    <div className="muted">
                      {m.destinataireNom ? m.destinataire : ''}
                      {m.entreprise ? `${m.destinataireNom ? ' · ' : ''}${m.entreprise}` : ''}
                    </div>
                  </td>
                  <td>
                    <strong>{MODELE[m.modele] ?? m.modele}</strong>
                    <div className="muted">{m.objet ?? ''}</div>
                    {m.erreur && m.statut !== 'ENVOYEE' && <div className="small alert-text">{m.erreur}</div>}
                  </td>
                  <td>
                    <StatusPill
                      label={m.statut === 'ENVOYEE' && m.fournisseur === 'JOURNAL' ? 'Préparé' : STATUT[m.statut]}
                      tone={m.statut === 'ECHEC' ? 'alert' : m.statut === 'EN_ATTENTE' ? 'lime' : m.statut === 'IGNOREE' ? 'dark' : 'neutral'}
                    />
                  </td>
                  <td>
                    <button type="button" className="btn small" onClick={() => void preview(m)} aria-expanded={open?.id === m.id}>
                      {open?.id === m.id ? 'Fermer' : 'Aperçu'}
                    </button>
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
