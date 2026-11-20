import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatEuros } from '@jamystock/domain';

/**
 * PDF des factures, avoirs et BL (§7.6, SUI-03) en pur JavaScript (pdf-lib) : aucun navigateur ni service
 * externe à faire tourner sur l'hébergement. Polices standard PDF (WinAnsi) : les caractères hors de ce jeu
 * sont remplacés plutôt que de faire échouer la génération.
 */

const INK = rgb(0.07, 0.09, 0.11);
const MUTED = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.85, 0.86, 0.88);
const ACCENT = rgb(0.78, 0.93, 0.29); // vert-citron de l'identité JAMYSTOCK
const A4: [number, number] = [595.28, 841.89];
const M = 48; // marge

const REPLACEMENTS: Record<string, string> = { ' ': ' ', ' ': ' ', '≥': '>=', '≤': '<=', '→': '->', '✓': 'OK', ' ': ' ' };

class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  private readonly ok = new Map<string, boolean>();

  constructor(
    readonly doc: PDFDocument,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
    private readonly footer: string,
  ) {
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage(A4);
    this.pages.push(this.page);
    this.y = A4[1] - M;
  }

  /** Texte encodable en WinAnsi. */
  safe(text: string): string {
    let out = '';
    for (const ch of text) {
      const c = REPLACEMENTS[ch] ?? ch;
      let good = this.ok.get(c);
      if (good === undefined) {
        try {
          this.regular.encodeText(c);
          good = true;
        } catch {
          good = false;
        }
        this.ok.set(c, good);
      }
      out += good ? c : '?';
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
  // date de création fixe = date du document : deux générations du même document donnent le même contenu
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return new Writer(doc, regular, bold, footer);
}

async function save(w: Writer, at: Date): Promise<Buffer> {
  w.doc.setCreationDate(at);
  w.doc.setModificationDate(at);
  w.finish();
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
  w.page.drawRectangle({ x: M, y: w.y - 4, width: 18, height: 18, color: ACCENT });
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
  w.page.drawRectangle({ x: 300, y: w.y - 66, width: right - 300, height: 78, color: rgb(0.965, 0.968, 0.972) });
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
  w.page.drawRectangle({ x: 300, y: w.y - 7, width: right - 300, height: 21, color: ACCENT });
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
  const w = await open(`${title} ${d.numero}`, `${d.issuer.raisonSociale} · ${title} ${d.numero} · signé le ${dateFr(d.signeLe)}`);
  const right = A4[0] - M;
  w.page.drawRectangle({ x: M, y: w.y - 4, width: 18, height: 18, color: ACCENT });
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
    ['Signé le', `${dateFr(d.signeLe)} à ${d.signeLe.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' })}`],
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
  return save(w, d.signeLe);
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
  w.page.drawRectangle({ x: M, y: w.y - 4, width: 18, height: 18, color: ACCENT });
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
