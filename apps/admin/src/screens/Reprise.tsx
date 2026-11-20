import { useCallback, useEffect, useState } from 'react';
import { get, post } from '../lib/api';
import { href } from '../lib/router';
import { Banner } from '../components/ui';

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`;

interface Issue {
  line: number;
  message: string;
}
interface Etat {
  articles: number;
  clients: number;
  photos: { A_TELECHARGER: number; TELECHARGEE: number; ECHEC: number };
  echecs: { url: string; erreur: string | null; libelle: string }[];
}
interface ClientsResult {
  lignes: number;
  valides: number;
  nbErreurs: number;
  erreurs: Issue[];
  colonnes: Record<string, string>;
  ignorees: string[];
  clientsCrees: number;
  contactsCrees: number;
  invitations: number;
  apercu: { line: number; client: string; action: 'CREE' | 'EXISTANT'; contact: string | null; contactAction: string }[];
}
interface ArticlesResult {
  lignes: number;
  valides: number;
  nbErreurs: number;
  erreurs: Issue[];
  nbAvertissements: number;
  avertissements: Issue[];
  colonnes: Record<string, string>;
  ignorees: string[];
  nouveauxClients: string[];
  articlesACreer: number;
  chezLeClient: number;
  dejaRepris: number;
  photos: number;
  cree: number;
  apercu: {
    line: number;
    client: string;
    projet: string | null;
    libelle: string;
    categorie: string | null;
    quantite: number;
    aCreer: number;
    emplacement: string | null;
    situation: 'EN_STOCK' | 'RESTITUE';
    photos: number;
  }[];
}
interface DepotRow {
  id: string;
  nom: string;
}
interface DepotDetail {
  emplacements: { id: string; code: string; chemin: string; adressable: boolean; statut: string }[];
  zones: { id: string; type: string }[];
}

const FIELD_LABELS: Record<string, string> = {
  libelle: 'Nom',
  reference: 'Référence',
  codeBarres: 'Code-barres',
  client: 'Client',
  projet: 'Projet',
  categorie: 'Catégorie',
  description: 'Description',
  quantite: 'Quantité',
  emplacement: 'Emplacement',
  longueurM: 'Longueur (m)',
  largeurM: 'Largeur (m)',
  hauteurM: 'Hauteur (m)',
  longueurCm: 'Longueur (cm)',
  largeurCm: 'Largeur (cm)',
  hauteurCm: 'Hauteur (cm)',
  poidsKg: 'Poids',
  etat: 'État',
  dateEntree: 'Date d’entrée',
  photos: 'Photos',
  type: 'Type',
  siret: 'SIRET',
  contactNom: 'Contact',
  email: 'E-mail',
  telephone: 'Téléphone',
  adresse: 'Adresse',
  projets: 'Projets',
};

function FilePick({ name, onFile }: { name: string | null; onFile: (name: string, text: string) => void }) {
  return (
    <label className="file-drop">
      <input
        type="file"
        accept=".csv,text/csv,text/plain"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          onFile(f.name, await f.text());
          e.target.value = '';
        }}
      />
      {name ? <strong>{name}</strong> : 'Choisir l’export CSV…'}
    </label>
  );
}

function Columns({ colonnes, ignorees }: { colonnes: Record<string, string>; ignorees: string[] }) {
  return (
    <p className="hint">
      Colonnes reconnues :{' '}
      {Object.entries(colonnes)
        .map(([f, h]) => `${FIELD_LABELS[f] ?? f} ← « ${h} »`)
        .join(' · ') || 'aucune'}
      {ignorees.length > 0 && <> — ignorées : {ignorees.map((h) => `« ${h} »`).join(', ')}</>}
    </p>
  );
}

function Issues({ title, items, total }: { title: string; items: Issue[]; total: number }) {
  if (!total) return null;
  return (
    <>
      <p>
        <strong>
          {title} ({total})
        </strong>
      </p>
      <ul className="errors">
        {items.slice(0, 12).map((er) => (
          <li key={`${er.line}-${er.message}`}>
            Ligne {er.line} : {er.message}
          </li>
        ))}
        {total > 12 && <li>… et {total - 12} autres</li>}
      </ul>
    </>
  );
}

/** Reprise des données de l'ancien logiciel (Monstock / « JAMYSO STOCK ») : comptes, stock, photos, bascule. */
export function Reprise() {
  const [etat, setEtat] = useState<Etat | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const refresh = useCallback(() => {
    get<Etat>('/bo/reprise')
      .then(setEtat)
      .catch((e) => setMsg({ kind: 'error', text: (e as Error).message }));
  }, []);
  useEffect(refresh, [refresh]);
  const done = (text: string) => {
    setMsg({ kind: 'ok', text });
    refresh();
  };
  const fail = (text: string) => setMsg({ kind: 'error', text });

  return (
    <>
      <section className="bo-head">
        <div>
          <p className="eyebrow">
            — <a href={href({ name: 'clients' })}>Clients</a>
          </p>
          <h1>Reprise des données</h1>
        </div>
      </section>
      <p className="hint">
        Chargez les exports CSV de l’ancien logiciel de stock. Chaque fichier est d’abord vérifié sans rien enregistrer ; l’import peut être relancé sans créer
        de doublon. Les colonnes sont reconnues automatiquement (Désignation, Nom technique, Code-barres, Quantité, Emplacement…).
      </p>
      {msg && <Banner kind={msg.kind}>{msg.text}</Banner>}
      {etat && (
        <section className="tiles">
          <div className="tile">
            <strong>{etat.articles.toLocaleString('fr-FR')}</strong>
            <span>objets repris</span>
          </div>
          <div className="tile">
            <strong>{etat.clients}</strong>
            <span>clients concernés</span>
          </div>
          <div className="tile">
            <strong>{etat.photos.TELECHARGEE.toLocaleString('fr-FR')}</strong>
            <span>photos rapatriées</span>
          </div>
          <div className="tile">
            <strong>{etat.photos.A_TELECHARGER.toLocaleString('fr-FR')}</strong>
            <span>photos en attente</span>
          </div>
        </section>
      )}
      <div className="stack">
        <section className="card stack">
          <h2>1. Comptes clients</h2>
          <ClientsImport onDone={done} onError={fail} />
        </section>
        <section className="card stack">
          <h2>2. Stock</h2>
          <ArticlesImport onDone={done} onError={fail} />
        </section>
        <section className="card stack">
          <h2>3. Photos</h2>
          <Photos etat={etat} onDone={done} onError={fail} />
        </section>
        <section className="card stack">
          <h2>4. Bascule</h2>
          <Bascule onDone={done} onError={fail} />
        </section>
      </div>
    </>
  );
}

function ClientsImport({ onDone, onError }: { onDone: (m: string) => void; onError: (m: string) => void }) {
  const [csv, setCsv] = useState('');
  const [name, setName] = useState<string | null>(null);
  const [res, setRes] = useState<ClientsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await post<ClientsResult>('/bo/reprise/clients', { csv, dryRun });
      if (dryRun) setRes(r);
      else {
        setRes(null);
        setCsv('');
        setName(null);
        onDone(`${plural(r.clientsCrees, 'compte client créé', 'comptes clients créés')}, ${plural(r.contactsCrees, 'contact invité', 'contacts invités')}.`);
      }
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="hint">
        Export des contacts ou clients : une ligne par client (colonnes Société, Contact, E-mail, Téléphone, Type…). Les contacts sont créés « invités », sans
        e-mail : le lien d’activation part à la bascule.
      </p>
      <FilePick
        name={name}
        onFile={(n, t) => {
          setName(n);
          setCsv(t);
          setRes(null);
        }}
      />
      {res && (
        <div className="preview-box">
          <Columns colonnes={res.colonnes} ignorees={res.ignorees} />
          <p>
            <strong>{plural(res.valides, 'ligne valide', 'lignes valides')}</strong> sur {res.lignes} ·{' '}
            {plural(res.clientsCrees, 'compte à créer', 'comptes à créer')} · {plural(res.contactsCrees, 'contact à inviter', 'contacts à inviter')}
          </p>
          <Issues title="Erreurs" items={res.erreurs} total={res.nbErreurs} />
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Ligne</th>
                  <th>Client</th>
                  <th>Compte</th>
                  <th>Contact</th>
                </tr>
              </thead>
              <tbody>
                {res.apercu.slice(0, 30).map((a) => (
                  <tr key={a.line}>
                    <td>{a.line}</td>
                    <td>{a.client}</td>
                    <td>{a.action === 'CREE' ? 'à créer' : 'existant'}</td>
                    <td>{a.contact ? `${a.contact}${a.contactAction === 'EXISTANT' ? ' (existant)' : ''}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <button
        type="button"
        className="btn primary"
        disabled={!csv || busy || (res != null && (res.nbErreurs > 0 || res.valides === 0))}
        onClick={() => void run(!res)}
      >
        {busy ? '…' : res ? `Importer ${plural(res.valides, 'client')}` : 'Vérifier le fichier'}
      </button>
      {res && res.nbErreurs > 0 && <p className="hint">Corrigez les lignes en erreur dans le fichier, puis rechargez-le.</p>}
    </>
  );
}

function ArticlesImport({ onDone, onError }: { onDone: (m: string) => void; onError: (m: string) => void }) {
  const [csv, setCsv] = useState('');
  const [name, setName] = useState<string | null>(null);
  const [res, setRes] = useState<ArticlesResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [depots, setDepots] = useState<DepotRow[]>([]);
  const [depotId, setDepotId] = useState('');
  const [locs, setLocs] = useState<DepotDetail['emplacements']>([]);
  const [defaut, setDefaut] = useState('');
  const [clientParDefaut, setClientParDefaut] = useState('');

  useEffect(() => {
    get<{ items: DepotRow[] }>('/bo/warehouse/depots')
      .then((r) => {
        setDepots(r.items);
        if (r.items[0]) setDepotId(r.items[0].id);
      })
      .catch((e) => onError((e as Error).message));
  }, [onError]);
  useEffect(() => {
    if (!depotId) return;
    get<DepotDetail>(`/bo/warehouse/depots/${depotId}`)
      .then((d) => {
        const list = d.emplacements.filter((e) => e.adressable && e.statut === 'ACTIF');
        setLocs(list);
        const reception = new Set(d.zones.filter((z) => z.type === 'RECEPTION').map((z) => z.id));
        const first = list.find((e) => reception.has((e as unknown as { zoneId: string }).zoneId)) ?? list[0];
        setDefaut(first?.id ?? '');
      })
      .catch((e) => onError((e as Error).message));
  }, [depotId, onError]);

  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await post<ArticlesResult>('/bo/reprise/articles', {
        csv,
        dryRun,
        depotId,
        emplacementParDefautId: defaut,
        ...(clientParDefaut.trim() ? { clientParDefaut: clientParDefaut.trim() } : {}),
      });
      if (dryRun) setRes(r);
      else {
        setRes(null);
        setCsv('');
        setName(null);
        onDone(`${plural(r.cree, 'objet repris', 'objets repris')} en stock, chacun avec son QR JAMYSTOCK. Imprimez leurs étiquettes depuis le Stock.`);
      }
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="hint">
        Export des produits / du stock : une ligne par produit. Une quantité de 3 donne 3 objets distincts, chacun avec son QR. La colonne « Situation » (en
        stock, chez le client, sorti) indique où se trouve chaque objet. Les emplacements reconnus sont repris ; les autres objets sont rangés à l’emplacement
        par défaut, à reclasser ensuite depuis l’app terrain.
      </p>
      <div className="form-grid">
        <label>
          Dépôt
          <select value={depotId} onChange={(e) => (setDepotId(e.target.value), setRes(null))}>
            {depots.map((d) => (
              <option key={d.id} value={d.id}>
                {d.nom}
              </option>
            ))}
          </select>
        </label>
        <label>
          Emplacement par défaut
          <select value={defaut} onChange={(e) => (setDefaut(e.target.value), setRes(null))}>
            {locs.map((l) => (
              <option key={l.id} value={l.id}>
                {l.chemin}
              </option>
            ))}
          </select>
        </label>
        <label>
          Client (si le fichier n’a pas de colonne client)
          <input value={clientParDefaut} onChange={(e) => (setClientParDefaut(e.target.value), setRes(null))} placeholder="ex. Cabinet Martel" />
        </label>
      </div>
      <FilePick
        name={name}
        onFile={(n, t) => {
          setName(n);
          setCsv(t);
          setRes(null);
        }}
      />
      {res && (
        <div className="preview-box">
          <Columns colonnes={res.colonnes} ignorees={res.ignorees} />
          <p>
            <strong>{plural(res.articlesACreer, 'objet à créer', 'objets à créer')}</strong> ({plural(res.valides, 'ligne valide', 'lignes valides')} sur{' '}
            {res.lignes}){res.chezLeClient > 0 && <> · dont {plural(res.chezLeClient, 'installé chez le client', 'installés chez le client')}</>}
            {res.dejaRepris > 0 && <> · {plural(res.dejaRepris, 'déjà repris')}</>}
            {res.photos > 0 && <> · {plural(res.photos, 'photo')} à rapatrier</>}
          </p>
          {res.nouveauxClients.length > 0 && (
            <p className="hint">
              Clients créés à l’import ({res.nouveauxClients.length}) : {res.nouveauxClients.slice(0, 15).join(', ')}
              {res.nouveauxClients.length > 15 && '…'} — importez d’abord les comptes clients pour leur rattacher un contact.
            </p>
          )}
          <Issues title="Erreurs" items={res.erreurs} total={res.nbErreurs} />
          <Issues title="Avertissements" items={res.avertissements} total={res.nbAvertissements} />
          <div className="table-wrap">
            <table className="table compact">
              <thead>
                <tr>
                  <th>Ligne</th>
                  <th>Client</th>
                  <th>Objet</th>
                  <th>Qté</th>
                  <th>Emplacement</th>
                  <th>Photos</th>
                </tr>
              </thead>
              <tbody>
                {res.apercu.slice(0, 30).map((a) => (
                  <tr key={a.line}>
                    <td>{a.line}</td>
                    <td>
                      {a.client}
                      {a.projet && <span className="hint"> · {a.projet}</span>}
                    </td>
                    <td>
                      {a.libelle}
                      {a.categorie && <span className="hint"> · {a.categorie}</span>}
                    </td>
                    <td>{a.aCreer === a.quantite ? a.quantite : `${a.aCreer}/${a.quantite}`}</td>
                    <td className="mono">{a.situation === 'RESTITUE' ? 'chez le client' : (a.emplacement ?? '—')}</td>
                    <td>{a.photos || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <button
        type="button"
        className="btn primary"
        disabled={!csv || !depotId || !defaut || busy || (res != null && (res.nbErreurs > 0 || res.articlesACreer === 0))}
        onClick={() => void run(!res)}
      >
        {busy ? '…' : res ? `Reprendre ${plural(res.articlesACreer, 'objet')}` : 'Vérifier le fichier'}
      </button>
    </>
  );
}

function Photos({ etat, onDone, onError }: { etat: Etat | null; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    let total = 0;
    let echecs = 0;
    try {
      for (;;) {
        const r = await post<{ telechargees: number; echecs: number; restant: number }>('/bo/reprise/photos', { lot: 25 });
        total += r.telechargees;
        echecs += r.echecs;
        setProgress(`${plural(total, 'photo rapatriée', 'photos rapatriées')}, ${r.restant.toLocaleString('fr-FR')} restantes…`);
        if (!r.restant || r.telechargees + r.echecs === 0) break;
      }
      onDone(`${plural(total, 'photo rapatriée', 'photos rapatriées')}${echecs ? `, ${plural(echecs, 'échec')}` : ''}.`);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };
  return (
    <>
      <p className="hint">
        Les photos de l’ancien logiciel sont téléchargées par lots et rattachées à chaque objet. Laissez la page ouverte pendant le rapatriement.
      </p>
      {progress && <p>{progress}</p>}
      <button type="button" className="btn primary" disabled={busy || !etat?.photos.A_TELECHARGER} onClick={() => void run()}>
        {busy ? '…' : `Rapatrier ${plural(etat?.photos.A_TELECHARGER ?? 0, 'photo')}`}
      </button>
      {etat && etat.echecs.length > 0 && (
        <details>
          <summary>{plural(etat.photos.ECHEC, 'photo non récupérée', 'photos non récupérées')}</summary>
          <ul className="errors">
            {etat.echecs.map((e) => (
              <li key={e.url + e.libelle}>
                {e.libelle} : {e.erreur} <span className="mono">{e.url}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function Bascule({ onDone, onError }: { onDone: (m: string) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await post<{ invitations: number }>('/bo/reprise/invitations', {});
      onDone(`${plural(r.invitations, 'lien d’activation envoyé', 'liens d’activation envoyés')}.`);
      setConfirm(false);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="hint">
        Le jour où l’adresse d’accès client pointe vers JAMYSTOCK, envoyez à chaque contact repris son lien d’activation (valable 7 jours) pour choisir son mot
        de passe.
      </p>
      <label className="check">
        <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> Les clients peuvent désormais se connecter à JAMYSTOCK
      </label>
      <button type="button" className="btn primary" disabled={busy || !confirm} onClick={() => void run()}>
        {busy ? '…' : 'Envoyer les liens d’activation'}
      </button>
    </>
  );
}
