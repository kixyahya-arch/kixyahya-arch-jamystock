/**
 * Modèles des e-mails (§6.3). Chaque modèle produit un sujet, un texte brut et une version HTML sobre.
 * Les variables viennent de la ligne `notification` ; les liens pointent vers l'Espace Client.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface TemplateContext {
  publicUrl: string;
  destinataire: string | null;
}

type Vars = Record<string, unknown>;

/** Messages transactionnels : envoyés quelles que soient les préférences de l'utilisateur (§6.3). */
export const TRANSACTIONAL = new Set(['INVITATION', 'LIVRAISON_EFFECTUEE', 'FACTURE_EMISE', 'PAIEMENT_ECHOUE', 'PAIEMENT_RECU', 'RELANCE_IMPAYE']);

/** Événements réglables par l'utilisateur dans « Mon compte ». */
export const OPTIONAL_EVENTS: { modele: string; libelle: string }[] = [
  { modele: 'COMMANDE_SOUMISE', libelle: 'Commande reçue' },
  { modele: 'VALIDATION_REQUISE', libelle: 'Commande à valider (administrateurs)' },
  { modele: 'VALIDATION_ACCORDEE', libelle: 'Commande validée en interne' },
  { modele: 'VALIDATION_REFUSEE', libelle: 'Commande refusée en interne' },
  { modele: 'CRENEAU_CONFIRME', libelle: 'Créneau confirmé ou contre-proposé' },
  { modele: 'CHAUFFEUR_EN_ROUTE', libelle: 'Chauffeur en route' },
  { modele: 'ARTICLES_MIS_EN_STOCK', libelle: 'Biens mis en stock après une collecte' },
];

const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const euros = (cents: unknown) =>
  typeof cents === 'number' ? `${(cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`.replace(/ /g, ' ') : '';

const dateFr = (v: unknown) => {
  if (!v) return '';
  const d = new Date(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
};

interface Spec {
  subject: string;
  lines: string[];
  action?: { label: string; path: string };
}

function spec(modele: string, v: Vars): Spec | null {
  const num = v.numero ? `la commande ${v.numero}` : 'votre commande';
  const order = v.commandeId ? `#/commandes/${v.commandeId}` : '#/commandes';
  switch (modele) {
    case 'INVITATION':
      return {
        subject: `${v.invitePar ?? 'Votre entreprise'} vous invite sur JAMYSTOCK`,
        lines: [
          `${v.invitePar ?? 'Un administrateur'} vous a ouvert un accès à l’Espace Client JAMYSTOCK de ${v.entreprise ?? 'votre entreprise'}.`,
          'Vous y retrouverez les biens stockés, photographiés et localisés, et pourrez demander une livraison ou une collecte.',
          `Choisissez votre mot de passe avec le bouton ci-dessous. Le lien est valable jusqu’au ${dateFr(v.expireLe)} et ne sert qu’une fois.`,
        ],
        action: { label: 'Activer mon accès', path: `#/invitation/${v.jeton}` },
      };
    case 'COMMANDE_SOUMISE':
      return { subject: `Demande reçue : ${v.numero ?? 'commande'}`, lines: [`Nous avons bien reçu ${num}. Le planning vous confirmera un créneau rapidement.`], action: { label: 'Suivre la commande', path: order } };
    case 'VALIDATION_REQUISE':
      return { subject: `Commande à valider : ${v.numero ?? ''}`.trim(), lines: [`${num.charAt(0).toUpperCase()}${num.slice(1)} attend votre validation interne avant d’être transmise à JAMYSTOCK.`], action: { label: 'Voir et valider', path: order } };
    case 'VALIDATION_ACCORDEE':
      return { subject: `Commande validée : ${v.numero ?? ''}`.trim(), lines: [`${num.charAt(0).toUpperCase()}${num.slice(1)} a été validée en interne et transmise à JAMYSTOCK.`], action: { label: 'Suivre la commande', path: order } };
    case 'VALIDATION_REFUSEE':
      return { subject: `Commande refusée : ${v.numero ?? ''}`.trim(), lines: [`${num.charAt(0).toUpperCase()}${num.slice(1)} a été refusée lors de la validation interne.`, v.motif ? `Motif : ${v.motif}` : ''].filter(Boolean), action: { label: 'Voir la commande', path: order } };
    case 'CRENEAU_CONFIRME':
      return { subject: `Créneau confirmé : ${v.numero ?? ''}`.trim(), lines: [`Le créneau de ${num} est confirmé${v.date ? ` pour le ${dateFr(v.date)}` : ''}.`], action: { label: 'Voir le détail', path: order } };
    case 'CRENEAU_CONTRE_PROPOSE':
      return { subject: `Nouveau créneau proposé : ${v.numero ?? ''}`.trim(), lines: [`Le créneau demandé pour ${num} n’est pas disponible : un autre créneau vous est proposé${v.date ? ` (le ${dateFr(v.date)})` : ''}.`], action: { label: 'Voir la proposition', path: order } };
    case 'CHAUFFEUR_EN_ROUTE':
      return { subject: `Votre livraison est en route : ${v.numero ?? ''}`.trim(), lines: [`Le chauffeur est parti avec ${num}.`], action: { label: 'Suivre la commande', path: order } };
    case 'LIVRAISON_EFFECTUEE':
      return {
        subject: `Livraison effectuée : ${v.numero ?? ''}`.trim(),
        lines: [`${num.charAt(0).toUpperCase()}${num.slice(1)} a été livrée${v.reserves ? ' avec réserves' : ''}. Le bon de livraison signé est disponible dans vos documents.`],
        action: { label: 'Voir le bon de livraison', path: order },
      };
    case 'ARTICLES_MIS_EN_STOCK':
      return {
        subject: `Biens mis en stock : ${v.numero ?? ''}`.trim(),
        lines: [`${v.nbArticles ?? 'Les'} bien${Number(v.nbArticles) > 1 ? 's ont' : ' a'} été photographié${Number(v.nbArticles) > 1 ? 's' : ''}, étiqueté${Number(v.nbArticles) > 1 ? 's' : ''} et rangé${Number(v.nbArticles) > 1 ? 's' : ''} au dépôt.`],
        action: { label: 'Voir mon stock', path: '#/' },
      };
    case 'FACTURE_EMISE':
      return {
        subject: `Votre facture ${v.numero} est disponible`,
        lines: [
          `La facture ${v.numero} d’un montant de ${euros(v.totalTtcCents)} TTC est disponible dans votre Espace Client.`,
          v.prelevement ? 'Elle sera réglée automatiquement avec votre moyen de paiement enregistré.' : v.echeance ? `Échéance : ${dateFr(v.echeance)}.` : '',
        ].filter(Boolean),
        action: { label: 'Voir la facture', path: '#/documents' },
      };
    case 'PAIEMENT_ECHOUE':
      return {
        subject: `Paiement refusé : facture ${v.numero}`,
        lines: [
          `Le paiement de la facture ${v.numero} (${euros(v.totalTtcCents)} TTC) n’a pas abouti${v.raison ? ` : ${v.raison}` : ''}.`,
          'Vous pouvez la régler en ligne ou mettre à jour votre moyen de paiement depuis votre Espace Client.',
        ],
        action: { label: 'Régler la facture', path: '#/documents' },
      };
    case 'RELANCE_IMPAYE': {
      const lvl = Number(v.niveau ?? 0);
      return {
        subject: lvl >= 3 ? `Dernier rappel : facture ${v.numero} impayée` : `Rappel : facture ${v.numero} en attente de règlement`,
        lines: [
          `Sauf erreur de notre part, la facture ${v.numero} arrivée à échéance le ${dateFr(v.echeance)} n’est pas encore réglée${v.joursRetard ? ` (${v.joursRetard} jours de retard)` : ''}.`,
          `Montant restant dû : ${euros(v.resteCents)} TTC.`,
          v.blocage
            ? 'Sans règlement de votre part, les prochaines restitutions de biens seront suspendues. Contactez-nous si un point bloque.'
            : 'Vous pouvez la régler en ligne depuis votre Espace Client. Si le paiement est déjà parti, merci de ne pas tenir compte de ce message.',
        ],
        action: { label: 'Régler la facture', path: '#/documents' },
      };
    }
    case 'PAIEMENT_RECU':
      return { subject: `Paiement reçu : facture ${v.numero}`, lines: [`Nous avons bien reçu votre paiement de ${euros(v.montantCents)} pour la facture ${v.numero}. Merci.`], action: { label: 'Mes documents', path: '#/documents' } };
    default:
      return null;
  }
}

/** Rend un modèle ; `null` si le modèle n'a pas de version e-mail. */
export function renderEmail(modele: string, vars: Vars, ctx: TemplateContext): RenderedEmail | null {
  const s = spec(modele, vars);
  if (!s) return null;
  const hello = ctx.destinataire ? `Bonjour ${ctx.destinataire},` : 'Bonjour,';
  const url = s.action ? `${ctx.publicUrl}/${s.action.path}` : null;
  const text = [hello, '', ...s.lines, ...(url ? ['', `${s.action!.label} : ${url}`] : []), '', '— JAMYSTOCK', 'Stockage tracé, objet par objet.'].join('\n');
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f4f4f2;font-family:Helvetica,Arial,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:8px">
<tr><td style="padding:24px 28px;border-bottom:1px solid #e6e6e2;font-size:20px;font-weight:700;letter-spacing:-0.5px">jamystock</td></tr>
<tr><td style="padding:28px;font-size:15px;line-height:1.55">
<p style="margin:0 0 16px">${esc(hello)}</p>
${s.lines.map((l) => `<p style="margin:0 0 14px">${esc(l)}</p>`).join('\n')}
${url ? `<p style="margin:24px 0 8px"><a href="${esc(url)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:600">${esc(s.action!.label)}</a></p>
<p style="margin:0;font-size:12px;color:#666;word-break:break-all">${esc(url)}</p>` : ''}
</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #e6e6e2;font-size:12px;color:#666">JAMYSTOCK · Stockage tracé, objet par objet.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject: s.subject, text, html };
}
