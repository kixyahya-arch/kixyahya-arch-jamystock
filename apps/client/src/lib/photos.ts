/**
 * Réduit une photo de téléphone (souvent 3 à 8 Mo) avant envoi : 1 600 px de côté au plus, JPEG qualité 0,82,
 * orientation corrigée. Si le navigateur ne sait pas la lire, l'originale part telle quelle (le serveur refuse
 * au-delà de 4 Mo ou hors JPEG, PNG, WebP).
 */
export async function shrinkPhoto(file: File, max = 1600): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * scale);
    const h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (!g) return file;
    g.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', 0.82));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}
