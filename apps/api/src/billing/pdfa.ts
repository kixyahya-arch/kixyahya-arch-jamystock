import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFHexString, PDFName, PDFString, type PDFDocument, type PDFFont } from 'pdf-lib';

/**
 * Archivage PDF/A-3b (§7.6) : polices incorporées (Liberation Sans, métriques identiques à Helvetica, licence OFL),
 * profil de couleur sRGB déclaré (OutputIntent), métadonnées XMP cohérentes avec le dictionnaire Info, identifiant
 * de fichier. Tout est dérivé du document lui-même : deux générations du même document restent identiques.
 */
const ASSETS = ['../../assets/pdf', '../../../assets/pdf'].map((rel) => fileURLToPath(new URL(rel, import.meta.url))).find((dir) => existsSync(dir));

let files: { regular: Buffer; bold: Buffer; icc: Buffer } | null = null;
function load() {
  if (!ASSETS) throw new Error('Polices PDF introuvables (apps/api/assets/pdf)');
  files ??= {
    regular: readFileSync(path.join(ASSETS, 'LiberationSans-Regular.ttf')),
    bold: readFileSync(path.join(ASSETS, 'LiberationSans-Bold.ttf')),
    icc: readFileSync(path.join(ASSETS, 'sRGB.icc')),
  };
  return files;
}

/** Polices incorporées en sous-ensemble ; nom fixe (préfixe de sous-ensemble) pour un résultat déterministe. */
export async function embedArchiveFonts(doc: PDFDocument): Promise<{ regular: PDFFont; bold: PDFFont }> {
  const f = load();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(f.regular, { subset: true, customName: 'JMSTKR+LiberationSans' });
  const bold = await doc.embedFont(f.bold, { subset: true, customName: 'JMSTKB+LiberationSans-Bold' });
  return { regular, bold };
}

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
/** Même instant que le dictionnaire Info de pdf-lib (D:AAAAMMJJHHmmSSZ), à la seconde. */
const xmpDate = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;

/** Déclare le document PDF/A-3b ; à appeler juste avant l'enregistrement, une fois titre et dates posés. */
export function markPdfA(doc: PDFDocument, o: { title: string; at: Date; producer: string }) {
  const f = load();
  const ctx = doc.context;
  const icc = ctx.flateStream(f.icc, { N: 3 });
  const intent = ctx.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'),
    Info: PDFString.of('sRGB IEC61966-2.1'),
    DestOutputProfile: ctx.register(icc),
  });
  doc.catalog.set(PDFName.of('OutputIntents'), ctx.obj([intent]));

  const date = xmpDate(o.at);
  const meta = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>3</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(o.title)}</rdf:li></rdf:Alt></dc:title>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:CreatorTool>${xml(o.producer)}</xmp:CreatorTool>
   <xmp:CreateDate>${date}</xmp:CreateDate>
   <xmp:ModifyDate>${date}</xmp:ModifyDate>
   <xmp:MetadataDate>${date}</xmp:MetadataDate>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdf:Producer>${xml(o.producer)}</pdf:Producer>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
  // flux de métadonnées non compressé, comme l'exige la norme
  const stream = ctx.stream(Buffer.from(meta, 'utf8'), { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), ctx.register(stream));
  const id = createHash('md5').update(`${o.title}|${o.at.toISOString()}`).digest('hex');
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(id), PDFHexString.of(id)]);
}
