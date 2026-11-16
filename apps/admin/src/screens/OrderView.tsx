import { useCallback, useEffect, useState } from 'react';
import { get, post } from '../lib/api';
import { href } from '../lib/router';
import type { OrderDetail, Planning } from '../lib/types';
import { MISSION_STATUS, MISSION_TYPE, ORDER_STATUS, ORDER_TYPE, ARTICLE_STATUS, dateFr, dateShort, timeFr } from '../lib/labels';
import { Banner, StatusPill, Thumb, Urgent, orderTone } from '../components/ui';
import { AssignForm } from '../components/Assign';

export function OrderView({ id }: { id: string }) {
  const [o, setO] = useState<OrderDetail | null>(null);
  const [res, setRes] = useState<Pick<Planning, 'ressources' | 'vehicules'> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    get<OrderDetail>(`/bo/orders/${id}`)
      .then(setO)
      .catch((e) => setError((e as Error).message));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    get<Planning>('/bo/planning').then(setRes).catch(() => undefined);
  }, []);

  if (error && !o) return <Banner kind="error">{error}</Banner>;
  if (!o) return <p className="hint">Chargement…</p>;

  const due = o.dateConfirmee ?? o.dateSouhaitee;
  const urgent = !!due && ['EN_ATTENTE_VALIDATION', 'SOUMISE', 'PLANIFIEE', 'EN_PREPARATION', 'PRETE'].includes(o.statut) && new Date(`${due}T00:00:00`).getTime() < Date.now() + 48 * 3600_000;
  const c = o.contraintesAcces ?? {};

  return (
    <>
      <a className="back-link" href={href({ name: 'demandes' })}>
        ← Toutes les demandes
      </a>
      <section className="bo-head">
        <div>
          <p className="eyebrow">
            — {ORDER_TYPE[o.type] ?? o.type} · <span className="mono">{o.numero}</span>
          </p>
          <h1>{o.client}</h1>
          <p className="lead">
            {o.projet ? `${o.projet} · ` : ''}demandée par {o.demandeur} le {dateFr(o.creeLe)}
          </p>
        </div>
        <div className="head-status">
          {urgent && <Urgent />}
          <StatusPill label={ORDER_STATUS[o.statut] ?? o.statut} tone={orderTone(o.statut)} />
        </div>
      </section>

      {notice && <Banner kind="ok">{notice}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}

      <div className="two-col">
        <div className="col-main">
          <section className="panel">
            <h2>{o.type === 'COLLECTE' ? 'À collecter' : `Biens demandés (${o.lignes.length})`}</h2>
            {o.descriptionCollecte && <p>{o.descriptionCollecte}</p>}
            <ul className="lines">
              {o.lignes.map((l) =>
                l.articleId ? (
                  <li key={l.id}>
                    <Thumb src={l.vignette} alt="" />
                    <div>
                      <strong>{l.libelle}</strong>
                      <span className="muted">
                        <span className="mono">{l.qrCode}</span> · {ARTICLE_STATUS[l.statutArticle ?? ''] ?? l.statutArticle}
                      </span>
                      <span className="loc">{l.localisation ?? 'Emplacement inconnu'}</span>
                    </div>
                  </li>
                ) : (
                  <li key={l.id} className="free">
                    <div>
                      <strong>{l.descriptionLibre}</strong>
                      {l.quantite && <span className="muted">Quantité estimée : {l.quantite}</span>}
                    </div>
                  </li>
                ),
              )}
            </ul>
            {(o.volumeM3 || o.vehiculeSuggere) && (
              <p className="muted">
                {o.volumeM3 ? `Volume ${o.volumeM3.toLocaleString('fr-FR')} m³` : ''}
                {o.poidsKg ? ` · ${o.poidsKg} kg` : ''}
                {o.vehiculeSuggere ? ` · véhicule suggéré : ${o.vehiculeSuggere}` : ''}
              </p>
            )}
          </section>

          <section className="panel">
            <h2>{o.type === 'RETRAIT' ? 'Retrait au dépôt' : 'Adresse et accès'}</h2>
            <dl className="facts">
              {o.type !== 'RETRAIT' && (
                <>
                  <dt>Adresse</dt>
                  <dd>{o.adresse?.libelle ?? '—'}</dd>
                </>
              )}
              {o.depot && (
                <>
                  <dt>Dépôt</dt>
                  <dd>{o.depot}</dd>
                </>
              )}
              {o.contactSite && (
                <>
                  <dt>Contact sur place</dt>
                  <dd>
                    {o.contactSite.nom} · <a href={`tel:${o.contactSite.telephone.replace(/\s/g, '')}`}>{o.contactSite.telephone}</a>
                  </dd>
                </>
              )}
              {c.etage !== undefined && (
                <>
                  <dt>Étage</dt>
                  <dd>{c.etage === 0 ? 'Rez-de-chaussée' : `${c.etage}e`}{c.ascenseur ? ' · ascenseur' : ''}</dd>
                </>
              )}
              {c.accesPL !== undefined && (
                <>
                  <dt>Accès poids lourd</dt>
                  <dd>{c.accesPL ? 'Oui' : 'Non'}</dd>
                </>
              )}
              {c.horairesChantier && (
                <>
                  <dt>Horaires du site</dt>
                  <dd>{c.horairesChantier}</dd>
                </>
              )}
              {c.consignes && (
                <>
                  <dt>Consignes</dt>
                  <dd>{c.consignes}</dd>
                </>
              )}
            </dl>
          </section>

          <section className="panel">
            <h2>Historique</h2>
            <ol className="timeline">
              {o.historique.map((h, i) => (
                <li key={i}>
                  <strong>{ORDER_STATUS[h.statut] ?? h.statut}</strong>
                  <span className="muted">
                    {dateFr(h.le)} à {timeFr(h.le)}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="col-side">
          <Schedule o={o} onDone={(msg) => (setNotice(msg), load())} onError={setError} />

          <section className="panel">
            <h2>Missions</h2>
            {o.missions.length === 0 ? (
              <p className="hint">Les missions sont créées quand la date est confirmée : préparation la veille, puis transport le jour J.</p>
            ) : (
              <ul className="missions">
                {o.missions.map((m) => (
                  <li key={m.id}>
                    <div className="mission-head">
                      <strong>{MISSION_TYPE[m.type] ?? m.type}</strong>
                      <StatusPill label={MISSION_STATUS[m.statut] ?? m.statut} tone={m.statut === 'A_AFFECTER' ? 'lime' : 'neutral'} />
                    </div>
                    <span className="muted">
                      {dateShort(m.debutPrevu)} · {timeFr(m.debutPrevu)}
                      {m.assigneNom ? ` · ${m.assigneNom}` : ''}
                      {m.vehicule ? ` · ${m.vehicule}` : ''}
                    </span>
                    {res && ['A_AFFECTER', 'AFFECTEE'].includes(m.statut) && (
                      <AssignForm
                        mission={m}
                        ressources={res.ressources}
                        vehicules={res.vehicules}
                        onDone={(w) => {
                          setNotice(w.length ? `Mission affectée. Attention : ${w.join(' ; ')}` : 'Mission affectée.');
                          load();
                        }}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </>
  );
}

/** FLX-02 : confirmer la date en un clic, ou proposer une autre date avec un message ; le client accepte en un clic. */
function Schedule({ o, onDone, onError }: { o: OrderDetail; onDone: (msg: string) => void; onError: (e: string) => void }) {
  const [date, setDate] = useState(o.dateSouhaitee ?? '');
  const [creneau, setCreneau] = useState(o.creneauSouhaite ?? '');
  const [other, setOther] = useState(false);
  const [newDate, setNewDate] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      onDone(msg);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (o.statut === 'EN_ATTENTE_VALIDATION') {
    return (
      <section className="panel">
        <h2>Date</h2>
        <p>Souhaitée le {dateFr(o.dateSouhaitee)}. La demande attend la validation de l’administrateur du client avant de pouvoir être confirmée.</p>
      </section>
    );
  }
  if (o.statut !== 'SOUMISE') {
    return (
      <section className="panel">
        <h2>Date</h2>
        <p>
          {o.dateConfirmee ? (
            <>
              Confirmée pour le <strong>{dateFr(o.dateConfirmee)}</strong>
              {o.creneauConfirme ? `, ${o.creneauConfirme}` : ''}.
            </>
          ) : (
            <>Souhaitée le {dateFr(o.dateSouhaitee)}.</>
          )}
        </p>
        {o.dateConfirmee && (
          <a className="link-arrow" href={href({ name: 'planning', date: o.dateConfirmee })}>
            Voir le planning du jour ↗
          </a>
        )}
      </section>
    );
  }

  return (
    <section className="panel callout-panel">
      <h2>Confirmer le créneau</h2>
      <p className="muted">
        Souhaité par le client : {dateFr(o.dateSouhaitee)}
        {o.creneauSouhaite ? `, ${o.creneauSouhaite}` : ''}.
      </p>
      {o.dateContreProposee && (
        <Banner kind="info">
          Vous avez proposé le {dateFr(o.dateContreProposee)}
          {o.messageDispatcher ? ` (« ${o.messageDispatcher} »)` : ''}. Le client n’a pas encore répondu.
        </Banner>
      )}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => post(`/orders/${o.id}/plan`, { date, ...(creneau ? { creneau } : {}) }), 'Créneau confirmé : le client est prévenu et les missions sont créées.');
        }}
      >
        <div className="row">
          <label>
            Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <label>
            Créneau
            <input value={creneau} onChange={(e) => setCreneau(e.target.value)} placeholder="08:00-12:00" maxLength={50} />
          </label>
        </div>
        <button className="btn primary" disabled={busy || !date}>
          Confirmer {date === o.dateSouhaitee ? 'la date souhaitée' : 'cette date'}
        </button>
      </form>

      {!other ? (
        <button type="button" className="link" onClick={() => setOther(true)}>
          Proposer une autre date au client
        </button>
      ) : (
        <form
          className="stack counter"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => post(`/orders/${o.id}/counter-propose`, { date: newDate, ...(message ? { message } : {}) }), 'Nouvelle date proposée : le client peut l’accepter en un clic.');
          }}
        >
          <label>
            Nouvelle date
            <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} required />
          </label>
          <label>
            Message au client
            <textarea rows={3} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Tournée complète ce jour-là, nous pouvons passer le lendemain matin." />
          </label>
          <div className="row-actions">
            <button className="btn" disabled={busy || !newDate}>
              Envoyer la proposition
            </button>
            <button type="button" className="btn ghost-dark" onClick={() => setOther(false)}>
              Annuler
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
