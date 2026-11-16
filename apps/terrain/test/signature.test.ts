import { describe, expect, it } from 'vitest';
import { strokesToSvg } from '../src/components/SignaturePad';

describe('signature au doigt (LIV-04)', () => {
  it('produit un SVG vectoriel, un chemin par trait', () => {
    const svg = strokesToSvg(
      [
        [
          [10, 20],
          [30.26, 40],
        ],
        [[50, 60]],
        [],
      ],
      600,
      240,
    );
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="0 0 600 240"/);
    expect(svg.match(/<path /g)).toHaveLength(2);
    expect(svg).toContain('d="M10.0 20.0 L30.3 40.0"');
  });

  it('un tracé vide donne un SVG sans trait', () => {
    expect(strokesToSvg([], 600, 240)).not.toContain('<path');
  });
});
