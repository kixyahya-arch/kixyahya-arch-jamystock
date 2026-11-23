import { degrees, PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { formatEuros } from '@jamystock/domain';
import { BRAND, drawBrandRule, drawBrandSymbol } from '../common/brand-pdf.js';
import { embedArchiveFonts, markPdfA } from './pdfa.js';

/**
 * PDF des factures, avoirs et BL (§7.6, SUI-03) en pur JavaScript (pdf-lib) : aucun navigateur ni service
 * externe à faire tourner sur l'hébergement. Format d'archivage PDF/A-3b (pdfa.ts) : polices incorporées ;
 * un caractère absent de la police est remplacé plutôt que de faire échouer la génération.
 */

// charte JAMYSTOCK (docs/charte-graphique.md) : encre pour le texte, clair pour le total, filet dégradé en haut de page
const INK = BRAND.encre;
const MUTED = BRAND.muted;
const LINE = BRAND.line;
const ACCENT = BRAND.clair;
const A4: [number, number] = [595.28, 841.89];
const M = 48; // marge

const REPLACEMENTS: Record<string, string> = { ' ': ' ', ' ': ' ', '≥': '>=', '≤': '<=', '→': '->', '✓': 'OK', ' ': ' ' };

class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  private readonly chars: Set<number>;

  constructor(
    readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
    private readonly footer: string,
    readonly title: string,
  ) {
    // PDF/A : aucun glyphe manquant (.notdef) ; on ne garde que les caractères présents dans les deux graisses
    const bolds = new Set(bold.getCharacterSet());
    this.chars = new Set(regular.getCharacterSet().filter((c) => bolds.has(c)));
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage(A4);
    this.pages.push(this.page);
    drawBrandRule(this.page, 0, A4[1] - 6, A4[0], 6);
    this.y = A4[1] - M;
  }

  /** Texte affichable avec les polices incorporées. */
  safe(text: string): string {
    let out = '';
    for (const ch of text) {
      const c = REPLACEMENTS[ch] ?? ch;
      out += [...c].every((x) => this.chars.has(x.codePointAt(0)!)) ? c : '?';
    }
    return out;
  }

  width(text: string, size: number, font = this.regular) {
    return font.widthOfTextAtSize(this.safe(text), size);
  }

  text(text: string, x: number, y: number, o: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; align?: 'left' | 'right' } = {}) {
    const size = o.size ?? 9.5;
    const font = o.font ?? this.regular;
    const t = this.safe(text);
    const dx = o.align === 'right' ? -font.widthOfTextAtSize(t, size) : 0;
    this.page.drawText(t, { x: x + dx, y, size, font, color: o.color ?? INK });
  }

  /** Découpe en lignes tenant dans maxWidth. */
  wrap(text: string, maxWidth: number, size: number, font = this.regular): string[] {
    const lines: string[] = [];
    for (const para of text.split('\n')) {
      let cur = '';
      for (const word of para.split(/\s+/)) {
        const next = cur ? `${cur} ${word}` : word;
        if (this.width(next, size, font) <= maxWidth || !cur) cur = next;
        else {
          lines.push(cur);
          cur = word;
        }
      }
      lines.push(cur);
    }
    return lines;
  }

  /** Paragraphe à la position courante, avec saut de page si besoin. */
  para(text: string, o: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; x?: number; width?: number; gap?: number } = {}) {
    const size = o.size ?? 9.5;
    const x = o.x ?? M;
    for (const l of this.wrap(text, o.width ?? A4[0] - x - M, size, o.font)) {
      this.ensure(size + 4);
      this.text(l, x, this.y, { size, font: o.font, color: o.color });
      this.y -= size + 3.5;
    }
    this.y -= o.gap ?? 0;
  }

  ensure(h: number) {
    if (this.y - h < M + 40) this.newPage();
  }

  rule(y = this.y, color = LINE) {
    this.page.drawLine({ start: { x: M, y }, end: { x: A4[0] - M, y }, thickness: 0.7, color });
  }

  finish() {
    const n = this.pages.length;
    this.pages.forEach((p, i) => {
      const t = this.safe(`${this.footer}  ·  page ${i + 1}/${n}`);
      p.drawText(t, { x: M, y: 28, size: 7.5, font: this.regular, color: MUTED });
    });
  }
}

async function open(title: string, footer: string) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer('JAMYSTOCK');
  doc.setCreator('JAMYSTOCK');
  const { regular, bold } = await embedArchiveFonts(doc);
  return new Writer(doc, regular, bold, footer, title);
}

// date de création fixe = date du document (à la seconde) : deux générations du même document donnent le même contenu
async function save(w: Writer, at: Date): Promise<Buffer> {
  const d = new Date(Math.floor(at.getTime() / 1000) * 1000);
  w.doc.setCreationDate(d);
  w.doc.setModificationDate(d);
  w.finish();
  markPdfA(w.doc, { title: w.title, at: d, producer: 'JAMYSTOCK' });
  return Buffer.from(await w.doc.save({ useObjectStreams: false }));
}

const dateFr = (iso: string | Date | null | undefined) =>
  iso ? new Date(typeof iso === 'string' && iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }) : '—';
const qty = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 4 });

export interface Issuer {
  raisonSociale: string;
  adresse?: string;
  siret?: string;
  tva?: string;
  iban?: string;
  email?: string;
}

export interface InvoicePdfData {
  issuer: Issuer;
  type: 'FACTURE' | 'AVOIR';
  numero: string;
  emiseLe: Date;
  echeance: string | null;
  periodeDebut: string | null;
  periodeFin: string | null;
  m2Factures: number | null;
  client: { nom: string; type: 'B2B' | 'B2C'; adresse?: string; siret?: string | null; tva?: string | null };
  conditionsPaiement?: string | null;
  bonDeCommande?: string | null;
  origine?: { numero: string; emiseLe: Date | string } | null;
  motif?: string | null;
  lignes: { libelle: string; quantite: number; unite: string; prixUnitaireHtCents: number; tauxTva: number; totalHtCents: number }[];
  totalHtCents: number;
  tvaCents: number;
  totalTtcCents: number;
}

/** Facture ou avoir avec les mentions obligatoires (RG-FAC-02). */
export async function invoicePdf(d: InvoicePdfData): Promise<Buffer> {
  const label = d.type === 'AVOIR' ? 'Avoir' : 'Facture';
  const w = await open(`${label} ${d.numero}`, `${d.issuer.raisonSociale} · ${label} ${d.numero} · émise le ${dateFr(d.emiseLe)}`);
  const right = A4[0] - M;

  // en-tête
  drawBrandSymbol(w.page, M + 2, w.y + 17, 24);
  w.text(d.issuer.raisonSociale, M + 26, w.y, { size: 15, font: w.bold });
  w.text(label.toUpperCase(), right, w.y, { size: 15, font: w.bold, align: 'right' });
  w.y -= 22;
  const issuerLines = [
    d.issuer.adresse ?? 'Adresse : à compléter dans les paramètres',
    `SIRET : ${d.issuer.siret ?? 'à compléter'}${d.issuer.tva ? ` · TVA ${d.issuer.tva}` : ''}`,
    ...(d.issuer.email ? [d.issuer.email] : []),
  ];
  const meta = [
    `N° ${d.numero}`,
    `Date d'émission : ${dateFr(d.emiseLe)}`,
    ...(d.echeance ? [`Échéance : ${dateFr(d.echeance)}`] : []),
    ...(d.periodeDebut ? [`Période : ${dateFr(d.periodeDebut)} au ${dateFr(d.periodeFin)}`] : []),
  ];
  const top = w.y;
  issuerLines.forEach((l, i) => w.text(l, M, top - i * 12.5, { size: 9, color: MUTED }));
  meta.forEach((l, i) => w.text(l, right, top - i * 12.5, { size: 9, align: 'right', font: i === 0 ? w.bold : w.regular }));
  w.y = top - Math.max(issuerLines.length, meta.length) * 12.5 - 14;

  // client
  w.page.drawRectangle({ x: 300, y: w.y - 66, width: right - 300, height: 78, color: rgb(0.933, 0.949, 0.965) });
  let cy = w.y;
  w.text(d.client.type === 'B2B' ? 'Facturé à' : 'Client', 312, cy, { size: 8, color: MUTED });
  cy -= 14;
  w.text(d.client.nom, 312, cy, { size: 11, font: w.bold });
  cy -= 13;
  for (const l of w.wrap(d.client.adresse ?? '', right - 324, 9).slice(0, 2)) {
    if (!l) continue;
    w.text(l, 312, cy, { size: 9 });
    cy -= 12;
  }
  const ids = [d.client.siret ? `SIRET ${d.client.siret}` : '', d.client.tva ? `TVA ${d.client.tva}` : ''].filter(Boolean).join(' · ');
  if (ids) w.text(ids, 312, cy, { size: 8.5, color: MUTED });
  w.y -= 90;

  if (d.type === 'AVOIR' && d.origine) {
    w.para(`Avoir sur la facture ${d.origine.numero} du ${dateFr(d.origine.emiseLe)}.`, { font: w.bold });
    if (d.motif) w.para(`Motif : ${d.motif}`, { gap: 4 });
  }
  if (d.bonDeCommande) w.para(`Bon de commande : ${d.bonDeCommande}`, { gap: 2 });
  if (d.m2Factures != null && d.type === 'FACTURE') {
    w.para(`Surface facturée du mois : ${qty(d.m2Factures)} m² (moyenne des surfaces quotidiennes, arrondie au 0,5 m² supérieur).`, { color: MUTED, size: 8.5, gap: 4 });
  }
  w.y -= 6;

  // tableau
  const cols = { label: M, qte: 330, unite: 338, pu: 450, tva: 488, total: right };
  const header = () => {
    w.page.drawRectangle({ x: M, y: w.y - 5, width: right - M, height: 18, color: INK });
    const o = { size: 8, font: w.bold, color: rgb(1, 1, 1) };
    w.text('Désignation', cols.label + 6, w.y, o);
    w.text('Qté', cols.qte, w.y, { ...o, align: 'right' });
    w.text('Unité', cols.unite, w.y, o);
    w.text('PU HT', cols.pu, w.y, { ...o, align: 'right' });
    w.text('TVA', cols.tva, w.y, { ...o, align: 'right' });
    w.text('Total HT', cols.total - 6, w.y, { ...o, align: 'right' });
    w.y -= 22;
  };
  header();
  for (const l of d.lignes) {
    const lines = w.wrap(l.libelle, cols.qte - cols.label - 50, 9);
    const h = lines.length * 12 + 6;
    if (w.y - h < M + 40) {
      w.newPage();
      header();
    }
    lines.forEach((t, i) => w.text(t, cols.label + 6, w.y - i * 12, { size: 9 }));
    w.text(qty(l.quantite), cols.qte, w.y, { size: 9, align: 'right' });
    w.text(l.unite, cols.unite, w.y, { size: 9, color: MUTED });
    w.text(formatEuros(l.prixUnitaireHtCents), cols.pu, w.y, { size: 9, align: 'right' });
    w.text(`${qty(l.tauxTva)} %`, cols.tva, w.y, { size: 9, align: 'right' });
    w.text(formatEuros(l.totalHtCents), cols.total - 6, w.y, { size: 9, align: 'right' });
    w.y -= h;
    w.rule(w.y + 8);
  }

  // totaux
  w.ensure(80);
  w.y -= 8;
  const byRate = new Map<number, number>();
  for (const l of d.lignes) byRate.set(l.tauxTva, (byRate.get(l.tauxTva) ?? 0) + l.totalHtCents);
  const tot = (k: string, v: string, strong = false) => {
    w.text(k, 420, w.y, { size: strong ? 10.5 : 9.5, font: strong ? w.bold : w.regular, align: 'right' });
    w.text(v, right - 6, w.y, { size: strong ? 10.5 : 9.5, font: strong ? w.bold : w.regular, align: 'right' });
    w.y -= strong ? 18 : 14;
  };
  tot('Total HT', formatEuros(d.totalHtCents));
  const rates = [...byRate.entries()];
  if (rates.length === 1) tot(`TVA ${qty(rates[0]![0])} %`, formatEuros(d.tvaCents));
  else for (const [rate, base] of rates) tot(`TVA ${qty(rate)} % sur ${formatEuros(base)}`, formatEuros(Math.round((base * rate) / 100)));
  w.y -= 8;
  w.page.drawRectangle({ x: 300, y: w.y - 7, width: right - 300, height: 21, color: ACCENT, borderColor: BRAND.vert, borderWidth: 0.8 });
  tot(d.type === 'AVOIR' ? 'Total TTC crédité' : 'Total TTC', formatEuros(d.totalTtcCents), true);
  w.y -= 14;

  // mentions (RG-FAC-02)
  w.ensure(110);
  w.rule();
  w.y -= 14;
  const mentions = [
    d.type === 'FACTURE'
      ? `Conditions de paiement : ${d.conditionsPaiement ?? '30 jours date de facture'}${d.echeance ? `, à régler au plus tard le ${dateFr(d.echeance)}` : ''}.${d.issuer.iban ? ` IBAN ${d.issuer.iban}.` : ''}`
      : 'Le montant de cet avoir vient en déduction de votre prochaine facture, ou vous est remboursé sur demande.',
    'Pas d’escompte pour paiement anticipé.',
    'En cas de retard de paiement, des pénalités sont exigibles au taux de trois fois le taux d’intérêt légal (art. L441-10 du Code de commerce).',
    ...(d.client.type === 'B2B' ? ['Indemnité forfaitaire pour frais de recouvrement due par le client professionnel en cas de retard : 40 €.'] : []),
    'Document émis par JAMYSTOCK. Une facture émise n’est jamais modifiée : toute correction donne lieu à un avoir.',
  ];
  for (const m of mentions) w.para(m, { size: 8, color: MUTED, gap: 1.5 });

  return save(w, d.emiseLe);
}

export interface BlPdfData {
  issuer: Issuer;
  numero: string;
  type: 'LIVRAISON' | 'RETRAIT' | 'REFUS' | 'ENLEVEMENT';
  commande: string | null;
  client: string;
  projet?: string | null;
  adresse?: string | null;
  signeLe: Date;
  signataire: { nom: string | null; qualite: string | null };
  gps?: { lat: number; lng: number; precision: number | null } | null;
  articles: { libelle: string; qr: string; etat: 'LIVRE' | 'REFUSE' | 'ENLEVE' }[];
  reserves: { article: string; type: string; commentaire: string | null }[];
  signatureSvg: string | null;
  empreinte: string | null;
  /** LIV-05 : destinataire absent, dépôt sans signature autorisé par le client */
  depot?: { lieu: string | null; nbPhotos: number } | null;
  /** horodatage serveur de réception du BL signé (§4.3) */
  recuLe?: Date | null;
  /** photos du BL (réserves, dépôt, livraison) en annexe, déjà converties en JPEG */
  photos?: { jpeg: Buffer; legende: string }[];
}

const BL_TITLE: Record<BlPdfData['type'], string> = {
  LIVRAISON: 'Bon de livraison',
  RETRAIT: 'Bon de retrait au dépôt',
  REFUS: 'Bon de livraison (refusée)',
  ENLEVEMENT: "Bon d'enlèvement",
};
const ETAT: Record<BlPdfData['articles'][number]['etat'], string> = { LIVRE: 'Livré', REFUSE: 'Refusé', ENLEVE: 'Enlevé' };

/** BL signé (LIV-04, LIV-06) : contenu, réserves, signature manuscrite et empreinte SHA-256 du contenu signé. */
export async function blPdf(d: BlPdfData): Promise<Buffer> {
  const title = BL_TITLE[d.type];
  const w = await open(`${title} ${d.numero}`, `${d.issuer.raisonSociale} · ${title} ${d.numero} · ${d.depot ? 'déposé sans signature' : 'signé'} le ${dateFr(d.signeLe)}`);
  const right = A4[0] - M;
  drawBrandSymbol(w.page, M + 2, w.y + 17, 24);
  w.text(d.issuer.raisonSociale, M + 26, w.y, { size: 15, font: w.bold });
  w.text(title.toUpperCase(), right, w.y, { size: 13, font: w.bold, align: 'right' });
  w.y -= 20;
  w.text(`N° ${d.numero}`, right, w.y, { size: 10, font: w.bold, align: 'right' });
  w.y -= 26;

  const facts: [string, string][] = [
    ['Client', d.client],
    ...(d.projet ? ([['Projet', d.projet]] as [string, string][]) : []),
    ...(d.commande ? ([['Demande', d.commande]] as [string, string][]) : []),
    ...(d.adresse ? ([['Adresse', d.adresse]] as [string, string][]) : []),
    [d.depot ? 'Déposé le' : 'Signé le', `${dateFr(d.signeLe)} à ${d.signeLe.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' })}`],
    ...(d.recuLe ? ([['Reçu le', `${dateFr(d.recuLe)} à ${d.recuLe.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', second: '2-digit' })} (horodatage du serveur)`]] as [string, string][]) : []),
    ...(d.gps ? ([['Position', `${d.gps.lat.toFixed(5)}, ${d.gps.lng.toFixed(5)}${d.gps.precision ? ` (± ${Math.round(d.gps.precision)} m)` : ''}`]] as [string, string][]) : []),
  ];
  for (const [k, v] of facts) {
    w.text(k, M, w.y, { size: 8.5, color: MUTED });
    w.para(v, { x: M + 80, size: 9.5 });
    w.y -= 2;
  }
  w.y -= 10;

  w.text(`Biens (${d.articles.length})`, M, w.y, { size: 11, font: w.bold });
  w.y -= 18;
  for (const a of d.articles) {
    w.ensure(16);
    w.text(a.libelle, M, w.y, { size: 9.5 });
    w.text(a.qr, 380, w.y, { size: 8.5, color: MUTED });
    w.text(ETAT[a.etat], right, w.y, { size: 9, font: a.etat === 'REFUSE' ? w.bold : w.regular, align: 'right' });
    w.y -= 8;
    w.rule();
    w.y -= 10;
  }
  if (d.reserves.length) {
    w.y -= 6;
    w.text('Réserves', M, w.y, { size: 11, font: w.bold });
    w.y -= 16;
    for (const r of d.reserves) w.para(`${r.article} : ${r.type.toLowerCase()}${r.commentaire ? ` (${r.commentaire})` : ''}`, { size: 9, gap: 2 });
  }

  if (d.depot) {
    w.ensure(120);
    w.y -= 14;
    w.page.drawRectangle({ x: M, y: w.y - 52, width: right - M, height: 64, borderColor: INK, borderWidth: 1.2 });
    w.text('NON SIGNÉ — DÉPOSÉ', M + 14, w.y - 8, { size: 13, font: w.bold });
    w.text(`Destinataire absent : dépôt autorisé par le client pour cette commande, le ${dateFr(d.signeLe)}.`, M + 14, w.y - 26, { size: 9 });
    w.text(`Lieu du dépôt : ${d.depot.lieu ?? '—'} · ${d.depot.nbPhotos} photo${d.depot.nbPhotos > 1 ? 's' : ''} du dépôt dans l’Espace Client.`, M + 14, w.y - 40, { size: 9, color: MUTED });
    w.y -= 78;
    if (d.empreinte) w.para(`Empreinte SHA-256 du contenu déposé : ${d.empreinte}`, { size: 7.5, color: MUTED });
    await annex(w, d.photos);
    return save(w, d.signeLe);
  }

  w.ensure(170);
  w.y -= 14;
  w.text('Signature du destinataire', M, w.y, { size: 9, color: MUTED });
  w.text(`${d.signataire.nom ?? ''}${d.signataire.qualite ? `, ${d.signataire.qualite}` : ''}`, M + 260, w.y, { size: 9.5, font: w.bold });
  w.y -= 8;
  const box = { x: M, y: w.y - 110, w: 240, h: 110 };
  w.page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, borderColor: LINE, borderWidth: 0.8 });
  drawSignature(w.page, d.signatureSvg, box);
  w.y = box.y - 22;
  if (d.empreinte) {
    w.para(`Empreinte SHA-256 du contenu signé : ${d.empreinte}`, { size: 7.5, color: MUTED });
    w.para('Cette empreinte, calculée sur le terminal au moment de la signature et vérifiée par le serveur, prouve que le contenu n’a pas été modifié.', {
      size: 7.5,
      color: MUTED,
    });
  }
  await annex(w, d.photos);
  return save(w, d.signeLe);
}

/** Annexe photos du BL : deux photos par page, avec leur légende. */
async function annex(w: Writer, photos: BlPdfData['photos']) {
  if (!photos?.length) return;
  const maxW = A4[0] - 2 * M;
  const maxH = (A4[1] - 2 * M - 120) / 2;
  for (const [i, p] of photos.entries()) {
    let img: PDFImage;
    try {
      img = await w.doc.embedJpg(p.jpeg);
    } catch {
      continue; // photo illisible : le BL part quand même
    }
    if (i % 2 === 0) {
      w.newPage();
      w.text(i === 0 ? `Annexe : photos (${photos.length})` : 'Annexe : photos (suite)', M, w.y, { size: 11, font: w.bold });
      w.y -= 22;
    }
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    const iw = img.width * scale;
    const ih = img.height * scale;
    w.page.drawImage(img, { x: M, y: w.y - ih, width: iw, height: ih });
    w.y -= ih + 12;
    w.text(p.legende, M, w.y, { size: 8.5, color: MUTED });
    w.y -= 22;
  }
}

/** Trace la signature manuscrite (SVG de tracés produits par l'app terrain) dans le cadre donné. */
function drawSignature(page: PDFPage, svg: string | null, box: { x: number; y: number; w: number; h: number }) {
  if (!svg) return;
  const vb = /viewBox="\s*([\d.\s-]+)"/.exec(svg)?.[1]?.trim().split(/\s+/).map(Number);
  const [vw, vh] = vb && vb.length === 4 ? [vb[2]!, vb[3]!] : [400, 160];
  const scale = Math.min((box.w - 16) / vw, (box.h - 16) / vh);
  const ox = box.x + (box.w - vw * scale) / 2;
  const oy = box.y + box.h - (box.h - vh * scale) / 2;
  for (const m of svg.matchAll(/\sd="([^"]+)"/g)) {
    try {
      page.drawSvgPath(m[1]!, { x: ox, y: oy, scale, borderColor: INK, borderWidth: 1.6 / scale });
    } catch {
      // tracé illisible : ignoré plutôt que de bloquer le document
    }
  }
}

// ===========================================================================================================
// INV-05 : inventaire illustré
// ===========================================================================================================

export interface InventoryPdfData {
  emetteur: string;
  client: string;
  filtres: string[];
  genereLe: Date;
  articles: {
    qrCode: string;
    libelle: string;
    nomClient: string | null;
    referenceInterne: string | null;
    categorie: string | null;
    projet: string | null;
    etat: string;
    statut: string;
    dimensions: string | null;
    dateEntree: string | null;
    note: string | null;
    /** vignette déjà convertie en JPEG (pdf-lib ne lit ni le WebP ni l'AVIF) */
    vignette: Buffer | null;
  }[];
}

/** Liste illustrée des biens, une ligne par bien avec sa vignette : à transmettre à un assureur ou à une direction. */
export async function inventoryPdf(d: InventoryPdfData): Promise<Buffer> {
  const w = await open(`Inventaire ${d.client}`, `${d.emetteur} · inventaire ${d.client} · ${dateFr(d.genereLe)}`);
  const right = A4[0] - M;
  drawBrandSymbol(w.page, M + 2, w.y + 17, 24);
  w.text(d.emetteur, M + 26, w.y, { size: 15, font: w.bold });
  w.text('INVENTAIRE', right, w.y, { size: 13, font: w.bold, align: 'right' });
  w.y -= 26;
  w.text(d.client, M, w.y, { size: 12, font: w.bold });
  w.y -= 15;
  w.para(
    `${d.articles.length} bien${d.articles.length > 1 ? 's' : ''} au ${dateFr(d.genereLe)} à ${d.genereLe.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' })}${d.filtres.length ? ` · ${d.filtres.join(' · ')}` : ''}`,
    { size: 9, color: MUTED, gap: 8 },
  );
  w.rule();
  w.y -= 8;

  const THUMB = 64;
  const textX = M + THUMB + 14;
  const textW = right - textX - 120;
  for (const a of d.articles) {
    const title = a.nomClient ? `${a.nomClient}` : a.libelle;
    const sub = [a.nomClient ? `Libellé dépôt : ${a.libelle}` : null, a.referenceInterne ? `Réf. ${a.referenceInterne}` : null, a.categorie, a.projet].filter(Boolean).join(' · ');
    const titleLines = w.wrap(title, textW, 10.5, w.bold).slice(0, 2);
    const subLines = sub ? w.wrap(sub, textW, 8.5).slice(0, 2) : [];
    const noteLines = a.note ? w.wrap(`Note : ${a.note}`, textW, 8.5).slice(0, 2) : [];
    const h = Math.max(THUMB, titleLines.length * 13 + subLines.length * 11 + noteLines.length * 11 + 4) + 12;
    w.ensure(h);
    const top = w.y;
    if (a.vignette) {
      try {
        const img = await w.doc.embedJpg(a.vignette);
        w.page.drawImage(img, { x: M, y: top - THUMB, width: THUMB, height: THUMB });
      } catch {
        w.page.drawRectangle({ x: M, y: top - THUMB, width: THUMB, height: THUMB, color: LINE });
      }
    } else {
      w.page.drawRectangle({ x: M, y: top - THUMB, width: THUMB, height: THUMB, color: LINE });
      w.text('sans photo', M + 8, top - THUMB / 2 - 3, { size: 7, color: MUTED });
    }
    let y = top - 10;
    for (const l of titleLines) {
      w.text(l, textX, y, { size: 10.5, font: w.bold });
      y -= 13;
    }
    for (const l of subLines) {
      w.text(l, textX, y, { size: 8.5, color: MUTED });
      y -= 11;
    }
    for (const l of noteLines) {
      w.text(l, textX, y, { size: 8.5 });
      y -= 11;
    }
    w.text(a.qrCode, right, top - 10, { size: 8.5, font: w.bold, align: 'right' });
    w.text(`${a.etat} · ${a.statut}`, right, top - 22, { size: 8.5, color: MUTED, align: 'right' });
    if (a.dimensions) w.text(a.dimensions, right, top - 34, { size: 8.5, color: MUTED, align: 'right' });
    if (a.dateEntree) w.text(`Entré le ${dateFr(a.dateEntree)}`, right, top - 46, { size: 8.5, color: MUTED, align: 'right' });
    w.y = top - h + 6;
    w.rule(w.y + 2);
    w.y -= 6;
  }
  return save(w, d.genereLe);
}

// ===========================================================================================================
// Packs : planche d'aménagement par pièce (compte rendu Adam, points 3, 4 et 8)
// ===========================================================================================================

export interface PlanchePdfData {
  emetteur: string;
  client: string;
  pack: string;
  site: string | null;
  description: string | null;
  genereLe: Date;
  /** pièces dans l'ordre d'affichage ; « ambiance » : visuel de la pièce aménagée (JPEG), quand il en existe un */
  pieces: {
    nom: string;
    ambiance?: Buffer | null;
    biens: { libelle: string; qr: string; dimensions: string | null; statut: string; photo: Buffer | null }[];
  }[];
}

const A3_PAYSAGE: [number, number] = [1190.55, 841.89];
/** format du grand cadre « ambiance » de la planche (60 % de la zone utile) : le visuel y est recadré avant l'envoi */
export const PLANCHE_AMBIANCE = { width: 1600, height: Math.round(1600 / ((A3_PAYSAGE[0] - 58 - 36) / (A3_PAYSAGE[1] - 30 - 128))) };

/**
 * Planche de décoration, sur le modèle remis par Adam (planche « Ambiance & vue 3D » d'un décorateur) : A3 paysage,
 * une page par pièce. Le visuel de la pièce aménagée occupe le grand cadre en haut à gauche ; les meubles sont
 * disposés autour, chacun détouré sur fond blanc avec son nom et ses dimensions. En bas, deux cartouches : la
 * pièce, et le projet (pack, site, client, date). Une page de garde ouvre la planche. Une pièce sans visuel
 * montre ses meubles seuls ; au-delà de huit meubles, la pièce continue sur une page « suite ».
 */
export async function planchePdf(d: PlanchePdfData): Promise<Buffer> {
  const w = await open(`Planche d'aménagement ${d.pack}`, `${d.emetteur} · planche d'aménagement « ${d.pack} » · ${dateFr(d.genereLe)}`);
  w.doc.removePage(0);
  w.pages.length = 0;
  const [PW, PH] = A3_PAYSAGE;
  const MX = 36;
  const right = PW - 58; // bande du texte vertical à droite
  const top = PH - 30;
  const bottom = 128; // au-dessus des cartouches
  const GAP = 16;
  const total = d.pieces.reduce((t, p) => t + p.biens.length, 0);
  const nommees = d.pieces.filter((p) => p.nom !== PIECE_A_REPARTIR).length;
  const WHITE = rgb(1, 1, 1);

  const newPage = () => {
    w.page = w.doc.addPage(A3_PAYSAGE);
    w.pages.push(w.page);
    drawBrandRule(w.page, 0, PH - 6, PW, 6);
    return w.page;
  };
  // une image n'est incorporée qu'une fois (le visuel de la page de garde est celui d'une pièce)
  const embedded = new Map<Buffer, PDFImage | null>();
  const image = async (buf: Buffer | null | undefined): Promise<PDFImage | null> => {
    if (!buf) return null;
    if (!embedded.has(buf)) embedded.set(buf, await w.doc.embedJpg(buf).catch(() => null));
    return embedded.get(buf)!;
  };
  /** image contenue dans le cadre, centrée */
  const contain = (img: PDFImage, x: number, y: number, bw: number, bh: number) => {
    const k = Math.min(bw / img.width, bh / img.height);
    w.page.drawImage(img, { x: x + (bw - img.width * k) / 2, y: y + (bh - img.height * k) / 2, width: img.width * k, height: img.height * k });
  };
  /** crochets d'angle, comme les cartouches du modèle */
  const brackets = (x: number, y: number, bw: number, bh: number) => {
    const t = 10;
    const line = (x1: number, y1: number, x2: number, y2: number) => w.page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 1, color: INK });
    line(x, y, x, y + bh);
    line(x, y + bh, x + t, y + bh);
    line(x, y, x + t, y);
    line(x + bw, y, x + bw, y + bh);
    line(x + bw, y + bh, x + bw - t, y + bh);
    line(x + bw, y, x + bw - t, y);
  };
  const centered = (text: string, cx: number, y: number, o: { size: number; font?: PDFFont; color?: ReturnType<typeof rgb> }) =>
    w.text(text, cx - w.width(text, o.size, o.font) / 2, y, o);
  const projet = [d.client, d.site].filter(Boolean).join(' · ');

  const chrome = (piece: string, sousTitre: string) => {
    // logo et organisation, en bas à gauche
    drawBrandSymbol(w.page, MX, 98, 46);
    w.text(d.emetteur, MX + 44, 66, { size: 13, font: w.bold });
    w.text('Mobilier & décoration', MX + 44, 50, { size: 9, color: MUTED });
    // cartouche de la pièce
    const c1x = 420;
    const c1w = 300;
    brackets(c1x, 44, c1w, 62);
    centered(piece.toUpperCase(), c1x + c1w / 2, 88, { size: 11, font: w.bold });
    centered(sousTitre, c1x + c1w / 2, 72, { size: 9 });
    centered('Mobilier & décoration', c1x + c1w / 2, 54, { size: 8.5, color: MUTED });
    // cartouche du projet
    const c2x = 750;
    const c2w = right - c2x;
    brackets(c2x, 44, c2w, 62);
    const cut = (t: string, size: number, font?: PDFFont) => {
      let out = t;
      while (out.length > 4 && w.width(out, size, font) > c2w - 24) out = `${out.slice(0, -2)}…`;
      return out;
    };
    centered(cut(d.pack.toUpperCase(), 10, w.bold), c2x + c2w / 2, 90, { size: 10, font: w.bold });
    centered(cut(projet, 8.5), c2x + c2w / 2, 75, { size: 8.5 });
    centered(`Planche établie le ${dateFr(d.genereLe)}`, c2x + c2w / 2, 54, { size: 8.5, color: MUTED });
    // mention verticale, bord droit
    w.page.drawText(w.safe('Visuels & 3D non contractuels · dimensions à vérifier sur place'), {
      x: PW - 22,
      y: 140,
      size: 7.5,
      font: w.regular,
      color: MUTED,
      rotate: degrees(90),
    });
  };

  /** un meuble : photo détourée sur fond blanc, nom et dimensions dessous */
  const bien = async (b: PlanchePdfData['pieces'][number]['biens'][number], x: number, y: number, bw: number, bh: number) => {
    const capH = 28;
    const img = await image(b.photo);
    if (img) contain(img, x, y + capH, bw, bh - capH);
    else {
      w.page.drawRectangle({ x, y: y + capH, width: bw, height: bh - capH, color: LINE });
      centered('photo à venir', x + bw / 2, y + capH + (bh - capH) / 2 - 3, { size: 8, color: MUTED });
    }
    const name = w.wrap(b.libelle, bw, 9, w.bold)[0] ?? '';
    centered(name, x + bw / 2, y + 15, { size: 9, font: w.bold });
    centered([b.dimensions, b.qr].filter(Boolean).join(' · '), x + bw / 2, y + 4, { size: 7.5, color: MUTED });
  };

  // page de garde : bandeau d'encre avec le projet, et le premier visuel de pièce à droite
  newPage();
  const coverImg = await image(d.pieces.find((p) => p.ambiance)?.ambiance);
  const panelW = coverImg ? 430 : PW;
  w.page.drawRectangle({ x: 0, y: 0, width: panelW, height: PH - 6, color: INK });
  if (coverImg) {
    const bw = PW - panelW;
    const bh = PH - 6;
    const k = Math.max(bw / coverImg.width, bh / coverImg.height);
    // remplissage : l'image déborde, le bandeau d'encre recouvre le côté gauche
    w.page.drawImage(coverImg, { x: panelW + (bw - coverImg.width * k) / 2, y: (bh - coverImg.height * k) / 2, width: coverImg.width * k, height: coverImg.height * k });
    w.page.drawRectangle({ x: 0, y: 0, width: panelW, height: PH - 6, color: INK });
  }
  drawBrandSymbol(w.page, 60, PH - 80, 64, { pin: WHITE, cube: INK });
  w.text(d.emetteur, 116, PH - 118, { size: 16, font: w.bold, color: WHITE });
  w.text("PLANCHE D'AMÉNAGEMENT", 60, 420, { size: 11, font: w.bold, color: rgb(0.55, 0.85, 0.75) });
  let cy = 384;
  for (const l of w.wrap(d.pack, panelW - 120, 30, w.bold).slice(0, 3)) {
    w.text(l, 60, cy, { size: 30, font: w.bold, color: WHITE });
    cy -= 36;
  }
  cy -= 4;
  for (const l of w.wrap(projet, panelW - 120, 12)) {
    w.text(l, 60, cy, { size: 12, color: WHITE });
    cy -= 17;
  }
  if (d.description) {
    cy -= 8;
    for (const l of w.wrap(d.description, panelW - 120, 10).slice(0, 5)) {
      w.text(l, 60, cy, { size: 10, color: rgb(0.8, 0.86, 0.9) });
      cy -= 14;
    }
  }
  w.text(`${total} bien${total > 1 ? 's' : ''}${nommees ? ` · ${nommees} pièce${nommees > 1 ? 's' : ''}` : ''}`, 60, 96, { size: 10, color: WHITE });
  w.text(`Établie le ${dateFr(d.genereLe)}`, 60, 80, { size: 10, color: rgb(0.8, 0.86, 0.9) });

  const CW = right - MX;
  const CH = top - bottom;
  for (const p of d.pieces) {
    const amb = await image(p.ambiance);
    let rest = [...p.biens];
    let first = true;
    while (first || rest.length) {
      newPage();
      chrome(first ? p.nom : `${p.nom} (suite)`, amb ? 'AMBIANCE & VUE 3D' : 'SÉLECTION DE MOBILIER');
      const cells: [number, number, number, number][] = [];
      if (first && amb) {
        // grand visuel à gauche, deux colonnes de meubles à droite ; au-delà de quatre meubles, une rangée dessous.
        // Le cadre garde le format du visuel (PLANCHE_AMBIANCE) ; un petit pack est centré verticalement.
        const ratio = PLANCHE_AMBIANCE.width / PLANCHE_AMBIANCE.height;
        const row = rest.length > 4;
        const aw = CW * (row ? 0.6 : 0.66);
        const ah = aw / ratio;
        const ax = MX;
        const blockTop = row ? top : top - (CH - ah) / 2;
        const ay = blockTop - ah;
        contain(amb, ax, ay, aw, ah);
        const rx = ax + aw + GAP;
        const rw = (right - rx - GAP) / 2;
        const rh = (ah - GAP) / 2;
        for (const r of [0, 1]) for (const c of [0, 1]) cells.push([rx + c * (rw + GAP), blockTop - (r + 1) * rh - r * GAP, rw, rh]);
        if (row) {
          const bh = ay - GAP - bottom;
          const bw = (CW - 3 * GAP) / 4;
          for (let c = 0; c < 4; c++) cells.push([MX + c * (bw + GAP), bottom, bw, bh]);
        }
      } else if (rest.length <= 4) {
        // peu de meubles : une rangée de grandes photos, centrée
        const n = Math.max(rest.length, 1);
        const bw = Math.min((CW - (n - 1) * GAP) / n, 340);
        const bh = Math.min(CH * 0.8, bw * 1.15);
        const x0 = MX + (CW - n * bw - (n - 1) * GAP) / 2;
        for (let c = 0; c < n; c++) cells.push([x0 + c * (bw + GAP), bottom + (CH - bh) / 2, bw, bh]);
      } else {
        const bw = (CW - 3 * GAP) / 4;
        const bh = (CH - GAP) / 2;
        for (const r of [0, 1]) for (let c = 0; c < 4; c++) cells.push([MX + c * (bw + GAP), top - (r + 1) * bh - r * GAP, bw, bh]);
      }
      const here = rest.slice(0, cells.length);
      rest = rest.slice(cells.length);
      for (const [i, b] of here.entries()) await bien(b, ...cells[i]!);
      if (!here.length && !amb) centered('Aucun bien dans cette pièce', MX + CW / 2, bottom + CH / 2, { size: 11, color: MUTED });
      first = false;
    }
  }
  return save(w, d.genereLe);
}

/** Nom de la rubrique des biens sans pièce attribuée. */
export const PIECE_A_REPARTIR = 'À répartir';

// ===========================================================================================================
// Bon de transfert (compte rendu Adam, points 7 et 8)
// ===========================================================================================================

export interface TransfertPdfData {
  emetteur: string;
  numero: string;
  client: string;
  statut: string;
  demandeLe: Date;
  demandePar: string | null;
  datePrevue: string | null;
  creneau: string | null;
  depart: { site: string | null; adresse: string | null };
  arrivee: { site: string | null; adresse: string | null };
  contact: { nom: string; telephone: string } | null;
  genereLe: Date;
  biens: { libelle: string; qr: string; dimensions: string | null; enleveLe: Date | null; deposeLe: Date | null; etat: string; photo: Buffer | null }[];
}

const heure = (d: Date) => `${dateFr(d)} à ${d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' })}`;

/** Bon de transfert de site à site : date, départ et arrivée, biens avec leur photo, enlèvement et dépôt de chacun. */
export async function transfertPdf(d: TransfertPdfData): Promise<Buffer> {
  const w = await open(`Bon de transfert ${d.numero}`, `${d.emetteur} · bon de transfert ${d.numero} · ${dateFr(d.genereLe)}`);
  const right = A4[0] - M;
  drawBrandSymbol(w.page, M + 2, w.y + 17, 24);
  w.text(d.emetteur, M + 26, w.y, { size: 15, font: w.bold });
  w.text('BON DE TRANSFERT', right, w.y, { size: 13, font: w.bold, align: 'right' });
  w.y -= 20;
  w.text(`N° ${d.numero}`, right, w.y, { size: 10, font: w.bold, align: 'right' });
  w.y -= 26;

  const facts: [string, string][] = [
    ['Client', d.client],
    ['Statut', d.statut],
    ['Date prévue', d.datePrevue ? `${dateFr(d.datePrevue)}${d.creneau ? ` · ${d.creneau}` : ''}` : 'à planifier'],
    ['Départ', [d.depart.site, d.depart.adresse].filter(Boolean).join(' · ') || '—'],
    ['Arrivée', [d.arrivee.site, d.arrivee.adresse].filter(Boolean).join(' · ') || '—'],
    ...(d.contact ? ([['Contact', `${d.contact.nom} · ${d.contact.telephone}`]] as [string, string][]) : []),
    ['Demandé le', `${heure(d.demandeLe)}${d.demandePar ? ` par ${d.demandePar}` : ''}`],
  ];
  for (const [k, v] of facts) {
    w.text(k, M, w.y, { size: 8.5, color: MUTED });
    w.para(v, { x: M + 80, size: 9.5 });
    w.y -= 2;
  }
  w.y -= 10;

  w.text(`Biens transférés (${d.biens.length})`, M, w.y, { size: 11, font: w.bold });
  w.y -= 10;
  w.rule();
  w.y -= 8;
  const THUMB = 54;
  const textX = M + THUMB + 12;
  for (const b of d.biens) {
    w.ensure(THUMB + 14);
    const top = w.y;
    if (b.photo) {
      try {
        const img = await w.doc.embedJpg(b.photo);
        w.page.drawImage(img, { x: M, y: top - THUMB, width: THUMB, height: THUMB });
      } catch {
        w.page.drawRectangle({ x: M, y: top - THUMB, width: THUMB, height: THUMB, color: LINE });
      }
    } else w.page.drawRectangle({ x: M, y: top - THUMB, width: THUMB, height: THUMB, color: LINE });
    const lines = w.wrap(b.libelle, 250, 10, w.bold).slice(0, 2);
    let y = top - 11;
    for (const l of lines) {
      w.text(l, textX, y, { size: 10, font: w.bold });
      y -= 12;
    }
    w.text([b.qr, b.dimensions].filter(Boolean).join(' · '), textX, y, { size: 8.5, color: MUTED });
    w.text(b.etat, right, top - 11, { size: 9, font: w.bold, align: 'right' });
    w.text(b.enleveLe ? `Enlevé le ${heure(b.enleveLe)}` : 'Enlèvement à venir', right, top - 24, { size: 8.5, color: MUTED, align: 'right' });
    w.text(b.deposeLe ? `Déposé le ${heure(b.deposeLe)}` : 'Dépôt à venir', right, top - 36, { size: 8.5, color: MUTED, align: 'right' });
    w.y = top - THUMB - 6;
    w.rule(w.y);
    w.y -= 8;
  }

  w.ensure(110);
  w.y -= 12;
  const half = (right - M - 20) / 2;
  for (const [i, label] of ['Remis au départ par', 'Reçu à l’arrivée par'].entries()) {
    const x = M + i * (half + 20);
    w.text(label, x, w.y, { size: 9, color: MUTED });
    w.page.drawRectangle({ x, y: w.y - 80, width: half, height: 70, borderColor: LINE, borderWidth: 0.8 });
  }
  w.y -= 92;
  w.para('Le chauffeur fait signer le bon d’enlèvement au départ et note le nom de la personne qui réceptionne à l’arrivée ; ces preuves restent dans l’Espace Client.', { size: 7.5, color: MUTED });
  return save(w, d.genereLe);
}
