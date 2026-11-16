import { describe, expect, it } from 'vitest';
import { blFingerprint as serverBl, pickupFingerprint as serverPickup } from '../../../packages/domain/src/hash';
import { blFingerprint, pickupFingerprint } from '../src/lib/device';

const bl = {
  missionId: '0190a0a0-0000-7000-8000-000000000001',
  blId: '0190a0a0-0000-7000-8000-0000000000b1',
  livres: ['0190a0a0-0000-7000-8000-0000000000a2', '0190a0a0-0000-7000-8000-0000000000a1'],
  refuses: [],
  reserves: [{ articleId: '0190a0a0-0000-7000-8000-0000000000a2', type: 'RAYURE' as const, commentaire: 'Coin abîmé, « léger »', photoIds: ['p2', 'p1'] }],
  signataire: { nom: 'Émilie Durand', qualite: 'Conductrice de travaux' },
  signatureSvg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 2 L3 4"/></svg>',
  signedAt: '2026-11-16T10:12:00.000Z',
};

describe('empreinte du BL (§4.3)', () => {
  it('le terminal (SubtleCrypto) et le serveur (Node) calculent la même empreinte', async () => {
    expect(await blFingerprint(bl as never)).toBe(serverBl(bl as never));
  });

  it('ne dépend pas de l’ordre dans lequel les articles ont été pointés', async () => {
    const shuffled = { ...bl, livres: [...bl.livres].reverse() };
    expect(await blFingerprint(shuffled as never)).toBe(await blFingerprint(bl as never));
  });

  it('change dès qu’un élément signé change', async () => {
    expect(await blFingerprint({ ...bl, refuses: ['0190a0a0-0000-7000-8000-0000000000a9'] } as never)).not.toBe(await blFingerprint(bl as never));
  });

  it('même accord pour le bon d’enlèvement (LIV-06)', async () => {
    const p = {
      missionId: bl.missionId,
      blId: bl.blId,
      articles: [{ articleId: 'a1', qr: 'A0000000001', libelle: 'Chaise', photos: [{ photoId: 'p1' }] }],
      signataire: bl.signataire,
      signatureSvg: bl.signatureSvg,
      signedAt: bl.signedAt,
    };
    expect(await pickupFingerprint(p as never)).toBe(serverPickup(p as never));
  });
});
