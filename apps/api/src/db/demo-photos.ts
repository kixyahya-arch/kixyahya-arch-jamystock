import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Photos de démonstration : illustrations SVG générées au seed, pour que l'inventaire de démo ait des
 * vignettes. En production, chaque photo vient du terminal (WebP compressé).
 */
const PICTOS: Record<string, string> = {
  desk: '<rect x="70" y="120" width="260" height="22" rx="4"/><rect x="86" y="142" width="16" height="110"/><rect x="298" y="142" width="16" height="110"/><rect x="200" y="142" width="98" height="70" rx="4"/>',
  chair: '<rect x="140" y="70" width="120" height="100" rx="14"/><rect x="128" y="170" width="144" height="26" rx="8"/><rect x="146" y="196" width="14" height="66"/><rect x="240" y="196" width="14" height="66"/>',
  sign: '<rect x="150" y="40" width="100" height="190" rx="8"/><rect x="128" y="230" width="144" height="26" rx="6"/><rect x="168" y="70" width="64" height="10" rx="5" opacity=".5"/><rect x="168" y="92" width="44" height="10" rx="5" opacity=".5"/>',
  building: '<rect x="60" y="110" width="280" height="150" rx="6"/><rect x="88" y="140" width="60" height="44" rx="4" opacity=".5"/><rect x="170" y="140" width="60" height="44" rx="4" opacity=".5"/><rect x="262" y="170" width="46" height="90" rx="4" opacity=".5"/>',
  box: '<path d="M90 120 200 80l110 40v120l-110 40-110-40z"/><path d="M90 120l110 40 110-40M200 160v120" fill="none" stroke-width="10" opacity=".5"/>',
};
const TINTS = ['#eef2f6', '#e0f2fe', '#ecfbf4', '#e6ecf2', '#ece9df'];

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function demoPhotoSvg(libelle: string, icon: string, seed: number): string {
  const tint = TINTS[seed % TINTS.length]!;
  const picto = PICTOS[icon] ?? PICTOS.box!;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><rect width="400" height="300" fill="${tint}"/><g fill="#000" stroke="#000">${picto}</g><text x="200" y="288" font-family="system-ui,sans-serif" font-size="15" text-anchor="middle" fill="#000" opacity=".55">${esc(libelle)}</text></svg>`;
}

export async function writeDemoPhoto(storageDir: string, key: string, svg: string): Promise<void> {
  const file = path.resolve(storageDir, key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, svg);
}
