import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { blPdf, invoicePdf } from '../src/billing/pdf.js';
import { crc32, zip } from '../src/billing/zip.js';
import { paymentDays } from '../src/billing/billing.service.js';

const issuer = { raisonSociale: 'JAMYSTOCK Démo', adresse: '1 rue du Dépôt, 93000 Bobigny' };
const SIGNATURE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 220" fill="none" stroke="#111"><path d="M40 160 C 90 40, 140 40, 180 150 S 260 200, 300 90"/><path d="M320 120 L 420 140 L 520 80"/></svg>';

describe('PDF', () => {
  it('facture : déterministe à date égale (régénération à l’identique)', async () => {
    const data = {
      issuer,
      type: 'FACTURE' as const,
      numero: 'FA-2026-000001',
      emiseLe: new Date('2026-11-03T08:00:00Z'),
      echeance: '2026-12-03',
      periodeDebut: '2026-10-01',
      periodeFin: '2026-10-31',
      m2Factures: 131.5,
      client: { nom: 'Promotion Horizon SAS', type: 'B2B' as const, siret: '12345678900011' },
      lignes: [{ libelle: 'Forfait 120 m² — octobre ≥ prévu', quantite: 1, unite: 'mois', prixUnitaireHtCents: 180000, tauxTva: 20, totalHtCents: 180000 }],
      totalHtCents: 180000,
      tvaCents: 36000,
      totalTtcCents: 216000,
    };
    const a = await invoicePdf(data);
    const b = await invoicePdf(data);
    expect(a.subarray(0, 5).toString()).toBe('%PDF-');
    expect(a.equals(b)).toBe(true);
  });

  it('facture longue : les lignes passent sur plusieurs pages', async () => {
    const lignes = Array.from({ length: 80 }, (_, i) => ({ libelle: `Livraison n° ${i + 1}`, quantite: 1, unite: 'livraison', prixUnitaireHtCents: 15000, tauxTva: 20, totalHtCents: 15000 }));
    const pdf = await invoicePdf({
      issuer, type: 'FACTURE', numero: 'FA-2026-000002', emiseLe: new Date(), echeance: null, periodeDebut: null, periodeFin: null, m2Factures: null,
      client: { nom: 'Camille Martin', type: 'B2C' }, lignes, totalHtCents: 1_200_000, tvaCents: 240_000, totalTtcCents: 1_440_000,
    });
    expect((pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length).toBeGreaterThan(1);
  });

  it('BL signé avec la signature manuscrite et l’empreinte', async () => {
    const pdf = await blPdf({
      issuer,
      numero: 'BL-2026-000007',
      type: 'LIVRAISON',
      commande: 'CMD-2026-000012',
      client: 'Promotion Horizon SAS',
      projet: 'Stand de vente Résidence Les Tilleuls',
      adresse: '12 rue des Tilleuls, 92100 Boulogne-Billancourt',
      signeLe: new Date('2026-11-12T09:41:00Z'),
      signataire: { nom: 'Paul Leroy', qualite: 'Conducteur de travaux' },
      gps: { lat: 48.8353, lng: 2.2412, precision: 12 },
      articles: [
        { libelle: 'Bureau direction chêne', qr: 'A-000123', etat: 'LIVRE' },
        { libelle: 'Chaise visiteur', qr: 'A-000124', etat: 'REFUSE' },
      ],
      reserves: [{ article: 'Bureau direction chêne', type: 'RAYURE', commentaire: 'Plateau rayé côté gauche' }],
      signatureSvg: SIGNATURE,
      empreinte: 'a'.repeat(64),
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(2000);
  });
});

describe('ZIP', () => {
  it('CRC-32 de référence', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('archive lisible : en-têtes, noms dédoublonnés et contenu compressé', () => {
    const a = Buffer.from('%PDF-1.7 premier');
    const z = zip([
      { name: 'FA-1.pdf', data: a },
      { name: 'FA-1.pdf', data: Buffer.from('second') },
    ]);
    expect(z.readUInt32LE(0)).toBe(0x04034b50);
    const nameLen = z.readUInt16LE(26);
    expect(z.subarray(30, 30 + nameLen).toString()).toBe('FA-1.pdf');
    const size = z.readUInt32LE(18);
    expect(inflateRawSync(z.subarray(30 + nameLen, 30 + nameLen + size)).equals(a)).toBe(true);
    expect(z.toString('latin1')).toContain('FA-1 (2).pdf');
    expect(z.readUInt32LE(z.length - 22)).toBe(0x06054b50);
    expect(z.readUInt16LE(z.length - 22 + 10)).toBe(2);
  });
});

describe('conditions de paiement', () => {
  it('lit le délai en jours, 30 par défaut', () => {
    expect(paymentDays('45 jours fin de mois')).toBe(45);
    expect(paymentDays('à 60j')).toBe(60);
    expect(paymentDays(null)).toBe(30);
    expect(paymentDays('à réception')).toBe(30);
  });
});
