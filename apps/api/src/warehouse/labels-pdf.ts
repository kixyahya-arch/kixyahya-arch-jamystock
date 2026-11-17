import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import { averySlots, type AveryFormat, type LabelContent, type ZebraFormatId, ZEBRA_FORMATS } from '@jamystock/domain';

/**
 * Étiquettes QR (WMS-03) : planche A4 aux formats Avery, ou une étiquette par page au format de l'imprimante
 * thermique quand on imprime en PDF plutôt qu'en ZPL. QR dessiné en vecteurs (net à toutes les tailles).
 */

const MM = 72 / 25.4;
const A4: [number, number] = [595.28, 841.89];
const INK = rgb(0, 0, 0);
const MUTED = rgb(0.3, 0.3, 0.3);

/** WinAnsi : remplace ce que les polices standard ne savent pas écrire. */
function safe(font: PDFFont, text: string): string {
  let out = '';
  for (const ch of text.replace(/[  ]/g, ' ')) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += '?';
    }
  }
  return out;
}

function fit(font: PDFFont, text: string, size: number, maxW: number): string {
  let t = safe(font, text);
  if (font.widthOfTextAtSize(t, size) <= maxW) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`.replace('…', '...'), size) > maxW) t = t.slice(0, -1);
  return `${t}...`;
}

/** Jusqu'à `lines` lignes coupées aux espaces ou aux « > » du chemin. */
function wrap(font: PDFFont, text: string, size: number, maxW: number, lines: number): string[] {
  const words = safe(font, text).split(/(?<=\s)|(?=>)/);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur + w;
    if (font.widthOfTextAtSize(next.trim(), size) <= maxW || !cur) cur = next;
    else {
      out.push(cur.trim());
      cur = w;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  if (out.length > lines) {
    const kept = out.slice(0, lines);
    kept[lines - 1] = fit(font, out.slice(lines - 1).join(' '), size, maxW);
    return kept;
  }
  return out;
}

function drawQr(page: PDFPage, data: string, x: number, yTop: number, size: number) {
  const qr = QRCode.create(data, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 1; // marge blanche minimale (la découpe de l'étiquette fait le reste)
  const cell = size / (n + 2 * quiet);
  for (let r = 0; r < n; r++) {
    // fusionne les modules noirs contigus d'une ligne : moins d'objets, rendu sans liseré
    let c = 0;
    while (c < n) {
      if (!qr.modules.get(r, c)) {
        c++;
        continue;
      }
      let end = c;
      while (end + 1 < n && qr.modules.get(r, end + 1)) end++;
      page.drawRectangle({ x: x + (quiet + c) * cell, y: yTop - (quiet + r + 1) * cell, width: (end - c + 1) * cell, height: cell, color: INK });
      c = end + 1;
    }
  }
}

/** Une étiquette dans un rectangle (coordonnées PDF, origine en bas à gauche). */
function drawLabel(page: PDFPage, fonts: { regular: PDFFont; bold: PDFFont }, l: LabelContent, box: { x: number; y: number; w: number; h: number }) {
  const pad = Math.min(box.w, box.h) * 0.07;
  const qrSize = Math.min(box.h - 2 * pad, box.w * 0.4);
  const top = box.y + box.h - pad;
  drawQr(page, l.qr, box.x + pad, box.y + box.h / 2 + qrSize / 2, qrSize);
  const tx = box.x + pad + qrSize + pad * 0.8;
  const tw = box.x + box.w - pad - tx;
  // le code est l'information principale : on réduit la police jusqu'à ce qu'il tienne en entier plutôt que de le tronquer
  const maxTitle = Math.max(6, Math.min(box.h * 0.2, 18));
  const titleWidth = fonts.bold.widthOfTextAtSize(safe(fonts.bold, l.titre), maxTitle);
  const titleSize = Math.max(5, Math.min(maxTitle, (maxTitle * tw) / titleWidth));
  const subSize = Math.max(4.5, Math.min(maxTitle * 0.52, 9));
  const depotSize = Math.max(4.5, Math.min(maxTitle * 0.48, 8));
  page.drawText(fit(fonts.bold, l.titre, titleSize, tw), { x: tx, y: top - titleSize * 0.85, size: titleSize, font: fonts.bold, color: INK });
  let y = top - titleSize * 0.85 - subSize * 1.5;
  const maxSubLines = Math.max(1, Math.floor((box.h - 2 * pad - titleSize - depotSize * 2) / (subSize * 1.2)));
  if (l.sousTitre) {
    for (const line of wrap(fonts.regular, l.sousTitre, subSize, tw, Math.min(3, maxSubLines))) {
      page.drawText(line, { x: tx, y, size: subSize, font: fonts.regular, color: INK });
      y -= subSize * 1.2;
    }
  }
  page.drawText(fit(fonts.bold, l.depot.toUpperCase(), depotSize, tw), { x: tx, y: box.y + pad, size: depotSize, font: fonts.bold, color: MUTED });
}

async function newDoc(title: string, at: Date) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer('JAMYSTOCK');
  doc.setCreator('JAMYSTOCK');
  doc.setCreationDate(at);
  doc.setModificationDate(at);
  return { doc, regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
}

/** Planche A4 Avery ; `skip` saute les étiquettes déjà décollées d'une planche entamée. */
export async function averySheetPdf(labels: LabelContent[], format: AveryFormat, opts: { skip?: number; at?: Date; outline?: boolean } = {}): Promise<Buffer> {
  const { doc, regular, bold } = await newDoc(`Étiquettes ${format.id}`, opts.at ?? new Date());
  const pages: PDFPage[] = [];
  for (const [i, s] of averySlots(format, labels.length, opts.skip ?? 0).entries()) {
    while (pages.length <= s.page) pages.push(doc.addPage(A4));
    const page = pages[s.page]!;
    const box = { x: s.x * MM, y: A4[1] - (s.y + format.hauteur) * MM, w: format.largeur * MM, h: format.hauteur * MM };
    if (opts.outline) page.drawRectangle({ ...{ x: box.x, y: box.y, width: box.w, height: box.h }, borderColor: rgb(0.85, 0.85, 0.85), borderWidth: 0.3 });
    drawLabel(page, { regular, bold }, labels[i]!, box);
  }
  if (!pages.length) doc.addPage(A4);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** Une étiquette par page au format du rouleau (pour imprimer depuis le PDF si le ZPL n'est pas possible). */
export async function rollPdf(labels: LabelContent[], formatId: ZebraFormatId, at = new Date()): Promise<Buffer> {
  const f = ZEBRA_FORMATS.find((z) => z.id === formatId)!;
  const { doc, regular, bold } = await newDoc(f.nom, at);
  const size: [number, number] = [f.largeur * MM, f.hauteur * MM];
  for (const l of labels) drawLabel(doc.addPage(size), { regular, bold }, l, { x: 0, y: 0, w: size[0], h: size[1] });
  if (!labels.length) doc.addPage(size);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
