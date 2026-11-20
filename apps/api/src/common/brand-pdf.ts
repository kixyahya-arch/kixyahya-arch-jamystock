import { LineCapStyle, rgb, type PDFPage, type RGB } from 'pdf-lib';

/**
 * Charte JAMYSTOCK pour les documents PDF (factures, avoirs, BL, inventaires, étiquettes).
 * Palette commune avec JAMYS : Azur #0EA5E9, Vert frais #16C47F, Encre #0A2A43, Clair #ECFBF4.
 * Les documents s'impriment : le symbole y est en version monochrome (encre) et le dégradé officiel
 * n'apparaît que dans le filet du haut de page.
 */
const hex = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);

export const BRAND = {
  azur: hex('#0ea5e9'),
  vert: hex('#16c47f'),
  encre: hex('#0a2a43'),
  clair: hex('#ecfbf4'),
  vertFonce: hex('#0b7a4f'),
  muted: hex('#4b6478'),
  line: hex('#dce3ea'),
  white: rgb(1, 1, 1),
} as const;

/** Symbole (repère de carte + colis), dessiné dans un repère 48 × 64. */
const PIN = 'M24 64C22 60 18.6 46.4 12.64 43A23 23 0 1 1 35.36 43C29.4 46.4 26 60 24 64Z';
const CUBE = 'M24 9.8 35.8 16.3V29.3L24 35.8 12.2 29.3V16.3Z';
const CUBE_FACES = 'M12.2 16.3 24 22.8 35.8 16.3M24 22.8V35.8';

/** Dessine le symbole, coin haut gauche en (x, yTop), sur `height` points de haut. */
export function drawBrandSymbol(page: PDFPage, x: number, yTop: number, height: number, o: { pin?: RGB; cube?: RGB } = {}) {
  const scale = height / 64;
  page.drawSvgPath(PIN, { x, y: yTop, scale, color: o.pin ?? BRAND.encre });
  for (const d of [CUBE, CUBE_FACES]) page.drawSvgPath(d, { x, y: yTop, scale, borderColor: o.cube ?? BRAND.white, borderWidth: 3.4, borderLineCap: LineCapStyle.Round });
  return (48 / 64) * height;
}

/** Filet du dégradé officiel (135° Azur → Vert frais), approché par bandes : les PDF standard n'ont pas de dégradé simple. */
export function drawBrandRule(page: PDFPage, x: number, y: number, width: number, height: number, steps = 48) {
  const a = BRAND.azur;
  const b = BRAND.vert;
  const w = width / steps;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const c = rgb(a.red + (b.red - a.red) * t, a.green + (b.green - a.green) * t, a.blue + (b.blue - a.blue) * t);
    page.drawRectangle({ x: x + i * w, y, width: w + 0.3, height, color: c });
  }
}
