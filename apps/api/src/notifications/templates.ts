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
export const TRANSACTIONAL = new Set(['INVITATION', 'LIVRAISON_EFFECTUEE', 'FACTURE_EMISE', 'PAIEMENT_ECHOUE', 'PAIEMENT_RECU', 'RELANCE_IMPAYE', 'EXPORT_PRET', 'PHOTO_PRETE', 'LITIGE_RECU', 'LITIGE_TRAITE']);

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

/** Dans un modèle de texte, les variables restent en {{repère}} (édition au Back-Office). */
const isMark = (v: unknown): v is string => typeof v === 'string' && v.startsWith('{{');

const euros = (cents: unknown) =>
  isMark(cents) ? cents : typeof cents === 'number' ? `${(cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`.replace(/ /g, ' ') : '';

const dateFr = (v: unknown) => {
  if (!v) return '';
  if (isMark(v)) return v;
  const d = new Date(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });
};

const heure = (v: unknown) => {
  if (isMark(v)) return v;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).replace(':', ' h ');
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
    case 'CHAUFFEUR_EN_ROUTE': {
      const collecte = v.type === 'COLLECTE';
      return {
        subject: collecte ? `Le chauffeur arrive pour votre collecte : ${v.numero ?? ''}`.trim() : `Votre livraison est en route : ${v.numero ?? ''}`.trim(),
        lines: [
          collecte
            ? `${v.chauffeur ? `${v.chauffeur}, votre chauffeur,` : 'Le chauffeur'} est en route pour enlever les biens de ${num}.`
            : `${v.chauffeur ? `${v.chauffeur}, votre chauffeur,` : 'Le chauffeur'} est parti avec ${num}.`,
          v.eta ? `Arrivée estimée vers ${heure(v.eta)}${Number(v.arretsAvant) > 0 ? `, après ${v.arretsAvant} autre${Number(v.arretsAvant) > 1 ? 's' : ''} arrêt${Number(v.arretsAvant) > 1 ? 's' : ''}` : ''}.` : '',
          'Suivez son trajet en direct et prévenez la personne sur place : le lien reste valable 48 heures, sans connexion.',
        ].filter(Boolean),
        action: v.suivi ? { label: 'Suivre le chauffeur', path: `#/suivi/${v.suivi}` } : { label: 'Suivre la commande', path: order },
      };
    }
    case 'LIVRAISON_EFFECTUEE':
      return {
        subject: `Livraison effectuée : ${v.numero ?? ''}`.trim(),
        lines: v.nonSigne
          ? [
              `${num.charAt(0).toUpperCase()}${num.slice(1)} a été déposée en votre absence, comme vous l’aviez autorisé${v.lieuDepot ? ` : ${v.lieuDepot}` : ''}.`,
              'Le bon de livraison, marqué « non signé, déposé », et les photos du dépôt sont dans vos documents. Un problème ? Signalez-le dans les 48 heures depuis la commande.',
            ]
          : [`${num.charAt(0).toUpperCase()}${num.slice(1)} a été livrée${v.reserves ? ' avec réserves' : ''}. Le bon de livraison signé est disponible dans vos documents.`],
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
    case 'EXPORT_PRET':
      return {
        subject: 'Votre inventaire illustré est prêt',
        lines: [`L’export PDF de votre inventaire (${v.nbArticles ?? 0} bien${Number(v.nbArticles) > 1 ? 's' : ''}) est prêt. Il reste téléchargeable 7 jours depuis votre Espace Client.`],
        action: { label: 'Télécharger l’inventaire', path: '#/?exports=1' },
      };
    case 'LITIGE_RECU':
      return {
        subject: `Signalement reçu : ${v.litige ?? ''}`.trim(),
        lines: [`Nous avons bien reçu votre signalement sur ${num}. Notre équipe l’examine et vous répond rapidement.`],
        action: { label: 'Suivre le signalement', path: order },
      };
    case 'LITIGE_TRAITE':
      return {
        subject: `Réponse à votre signalement : ${v.litige ?? ''}`.trim(),
        lines: [
          v.statut === 'REJETE'
            ? `Nous avons examiné votre signalement sur ${num} et ne pouvons pas y donner suite.`
            : v.statut === 'RESOLU'
              ? `Votre signalement sur ${num} est résolu.`
              : `Votre signalement sur ${num} est pris en charge.`,
          v.reponse ? `Notre réponse : ${v.reponse}` : '',
          typeof v.gesteCents === 'number' && v.gesteCents > 0 ? `Un geste commercial de ${euros(v.gesteCents)} HT sera déduit de votre prochaine facture.` : '',
        ].filter(Boolean),
        action: { label: 'Voir le détail', path: order },
      };
    case 'PHOTO_PRETE':
      return {
        subject: v.demande === 'CONSTAT' ? `Constat effectué : ${v.libelle ?? 'votre bien'}` : `Nouvelle photo : ${v.libelle ?? 'votre bien'}`,
        lines: [
          v.demande === 'CONSTAT'
            ? `Nous avons examiné « ${v.libelle} » comme demandé. Les photos et notre constat sont sur sa fiche.`
            : `Les photos demandées de « ${v.libelle} » sont disponibles sur sa fiche.`,
          v.commentaire ? `Commentaire de l’opérateur : ${v.commentaire}` : '',
        ].filter(Boolean),
        action: { label: 'Voir le bien', path: `#/article/${v.articleId}` },
      };
    case 'PAIEMENT_RECU':
      return { subject: `Paiement reçu : facture ${v.numero}`, lines: [`Nous avons bien reçu votre paiement de ${euros(v.montantCents)} pour la facture ${v.numero}. Merci.`], action: { label: 'Mes documents', path: '#/documents' } };
    default:
      return null;
  }
}

/** Texte personnalisé par l'exploitant (Back-Office) : sujet, paragraphes séparés par une ligne vide, libellé du bouton. */
export interface EmailOverride {
  sujet: string;
  corps: string;
  bouton: string | null;
}

/**
 * Modèles modifiables, avec des variables d'exemple pour l'aperçu. Les valeurs booléennes choisissent la variante
 * du texte d'origine proposée comme point de départ.
 */
export const EDITABLE: { modele: string; libelle: string; exemple: Vars }[] = [
  { modele: 'INVITATION', libelle: 'Invitation d’un utilisateur', exemple: { invitePar: 'Sophie Durand', entreprise: 'Promotion Horizon SAS', expireLe: '2026-12-01', jeton: 'exemple' } },
  { modele: 'COMMANDE_SOUMISE', libelle: 'Commande reçue', exemple: { numero: 'CMD-2026-000042', commandeId: 'exemple' } },
  { modele: 'VALIDATION_REQUISE', libelle: 'Commande à valider', exemple: { numero: 'CMD-2026-000042', commandeId: 'exemple' } },
  { modele: 'VALIDATION_ACCORDEE', libelle: 'Commande validée en interne', exemple: { numero: 'CMD-2026-000042', commandeId: 'exemple' } },
  { modele: 'VALIDATION_REFUSEE', libelle: 'Commande refusée en interne', exemple: { numero: 'CMD-2026-000042', commandeId: 'exemple', motif: 'Budget du trimestre atteint' } },
  { modele: 'CRENEAU_CONFIRME', libelle: 'Créneau confirmé', exemple: { numero: 'CMD-2026-000042', commandeId: 'exemple', date: '2026-11-26' } },
  { modele: 'CRENEAU_CONTRE_PROPOSE', libelle: 'Créneau contre-proposé', exemple: { numero: 'CMD-2026-000042', commandeId: 'exemple', date: '2026-11-27' } },
  { modele: 'CHAUFFEUR_EN_ROUTE', libelle: 'Chauffeur en route (lien de suivi)', exemple: { numero: 'CMD-2026-000042', commandeId: 'exemple', chauffeur: 'Karim', eta: '2026-11-26T13:20:00Z', arretsAvant: 1, suivi: 'exemple', type: 'LIVRAISON' } },
  { modele: 'LIVRAISON_EFFECTUEE', libelle: 'Livraison effectuée', exemple: { numero: 'CMD-2026-000042', commandeId: 'exemple' } },
  { modele: 'ARTICLES_MIS_EN_STOCK', libelle: 'Biens mis en stock', exemple: { numero: 'CMD-2026-000043', nbArticles: 12 } },
  { modele: 'FACTURE_EMISE', libelle: 'Facture émise', exemple: { numero: 'FA-2026-000120', totalTtcCents: 48600, echeance: '2026-12-31' } },
  { modele: 'PAIEMENT_ECHOUE', libelle: 'Paiement refusé', exemple: { numero: 'FA-2026-000120', totalTtcCents: 48600, raison: 'Provision insuffisante' } },
  { modele: 'PAIEMENT_RECU', libelle: 'Paiement reçu', exemple: { numero: 'FA-2026-000120', montantCents: 48600 } },
  { modele: 'RELANCE_IMPAYE', libelle: 'Relance d’impayé', exemple: { numero: 'FA-2026-000120', echeance: '2026-10-31', joursRetard: 15, resteCents: 48600, niveau: 2 } },
  { modele: 'EXPORT_PRET', libelle: 'Inventaire illustré prêt', exemple: { nbArticles: 230 } },
  { modele: 'LITIGE_RECU', libelle: 'Signalement reçu', exemple: { numero: 'CMD-2026-000042', commandeId: 'exemple', litige: 'LIT-2026-000003' } },
  { modele: 'LITIGE_TRAITE', libelle: 'Réponse à un signalement', exemple: { numero: 'CMD-2026-000042', commandeId: 'exemple', litige: 'LIT-2026-000003', statut: 'RESOLU', reponse: 'Le plateau sera remplacé.' } },
  { modele: 'PHOTO_PRETE', libelle: 'Photo ou constat prêt', exemple: { libelle: 'Bureau d’accueil 1', articleId: 'exemple', demande: 'PHOTO' } },
];

/** Repères utilisables dans un modèle : les variables de l'exemple. */
export function placeholders(modele: string): string[] {
  const e = EDITABLE.find((x) => x.modele === modele);
  return e ? Object.entries(e.exemple).filter(([k, v]) => typeof v !== 'boolean' && !['commandeId', 'articleId', 'jeton', 'suivi', 'type', 'statut', 'demande'].includes(k)).map(([k]) => k) : [];
}

/** Texte d'origine d'un modèle, variables en {{repère}} : point de départ de l'édition. */
export function defaultTemplate(modele: string): EmailOverride | null {
  const e = EDITABLE.find((x) => x.modele === modele);
  if (!e) return null;
  const marks = Object.fromEntries(Object.entries(e.exemple).map(([k, v]) => [k, placeholders(modele).includes(k) ? `{{${k}}}` : v]));
  const s = spec(modele, marks);
  if (!s) return null;
  return { sujet: s.subject, corps: s.lines.join('\n\n'), bouton: s.action?.label ?? null };
}

function fill(text: string, vars: Vars): string {
  return text.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_m, k: string) => {
    const v = vars[k];
    if (v === undefined || v === null) return '';
    if (/Cents$/.test(k)) return euros(v);
    if (k === 'eta') return heure(v);
    if (['date', 'echeance', 'expireLe'].includes(k)) return dateFr(v);
    return String(v);
  });
}

/** Rend un modèle ; `null` si le modèle n'a pas de version e-mail. */
export function renderEmail(modele: string, vars: Vars, ctx: TemplateContext, override?: EmailOverride | null): RenderedEmail | null {
  const base = spec(modele, vars);
  if (!base) return null;
  const s: Spec = override
    ? {
        subject: fill(override.sujet, vars).trim() || base.subject,
        lines: fill(override.corps, vars).split(/\n\s*\n/).map((l) => l.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean),
        action: base.action && { ...base.action, label: override.bouton?.trim() || base.action.label },
      }
    : base;
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
