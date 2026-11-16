import { useRef, useState } from 'react';

/** Une signature = des traits (suites de points) ; convertie en SVG vectoriel pour le BL (§4.3). */
export type Stroke = [number, number][];

export function strokesToSvg(strokes: Stroke[], width: number, height: number): string {
  const paths = strokes
    .filter((s) => s.length > 0)
    .map((s) => {
      const [first, ...rest] = s;
      const d = `M${first![0].toFixed(1)} ${first![1].toFixed(1)}` + rest.map(([x, y]) => ` L${x.toFixed(1)} ${y.toFixed(1)}`).join('');
      return `<path d="${d}"/>`;
    })
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" fill="none" stroke="#111" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

interface Props {
  onChange: (svg: string | null) => void;
}

const W = 600;
const H = 240;

/** Signature au doigt ou au stylet (LIV-04), utilisable hors-ligne. */
export function SignaturePad({ onChange }: Props) {
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const drawing = useRef(false);
  const svgRef = useRef<SVGSVGElement>(null);

  const point = (e: React.PointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };

  const update = (next: Stroke[]) => {
    setStrokes(next);
    const ink = next.reduce((n, s) => n + s.length, 0);
    onChange(ink >= 5 ? strokesToSvg(next, W, H) : null);
  };

  return (
    <div className="signature">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Zone de signature"
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          drawing.current = true;
          update([...strokes, [point(e)]]);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const copy = strokes.slice();
          copy[copy.length - 1] = [...copy[copy.length - 1]!, point(e)];
          update(copy);
        }}
        onPointerUp={() => (drawing.current = false)}
        onPointerCancel={() => (drawing.current = false)}
      >
        <line x1="20" y1={H - 40} x2={W - 20} y2={H - 40} className="signature-line" />
        {strokes.map((s, i) => (
          <polyline key={i} points={s.map((p) => p.join(',')).join(' ')} className="signature-ink" />
        ))}
      </svg>
      <button type="button" className="btn secondary" onClick={() => update([])} disabled={!strokes.length}>
        Effacer
      </button>
    </div>
  );
}
