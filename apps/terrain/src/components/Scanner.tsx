import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import { parseQr, type QrType } from '@jamystock/domain/browser';
import { feedback } from '../lib/device';

interface Props {
  /** types de QR attendus (A article, U unité, E emplacement) */
  expect: QrType[];
  label: string;
  onScan: (qr: string, type: QrType) => void;
  /** rafale : la caméra reste ouverte après chaque lecture (O9) */
  burst?: boolean;
}

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };

/**
 * Lecture QR : caméra (BarcodeDetector natif, jsQR en repli) et champ texte pour les douchettes
 * Bluetooth et terminaux Zebra en mode clavier (§7.6). Aucune saisie clavier n'est nécessaire.
 */
export function Scanner({ expect, label, onScan, burst = false }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const last = useRef<{ code: string; at: number }>({ code: '', at: 0 });
  const [camera, setCamera] = useState<'off' | 'on' | 'denied'>('off');
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  const handle = (raw: string) => {
    const now = Date.now();
    if (raw === last.current.code && now - last.current.at < 1500) return; // anti-rebond caméra
    last.current = { code: raw, at: now };
    const parsed = parseQr(raw);
    if (!parsed || !expect.includes(parsed.type)) {
      feedback('error');
      setError(parsed ? `QR ${typeName(parsed.type)} : attendu ${expect.map(typeName).join(' ou ')}` : 'QR non reconnu');
      return;
    }
    setError(null);
    feedback('ok');
    if (!burst) setCamera('off');
    onScan(parsed.qr, parsed.type);
  };

  useEffect(() => {
    if (camera !== 'on') return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const native: Detector | null =
      'BarcodeDetector' in window ? new (window as unknown as { BarcodeDetector: new (o: object) => Detector }).BarcodeDetector({ formats: ['qr_code'] }) : null;

    const loop = async () => {
      if (stopped || !video.current) return;
      const v = video.current;
      if (v.readyState >= 2) {
        try {
          if (native) {
            const codes = await native.detect(v);
            if (codes[0]) handle(codes[0].rawValue);
          } else {
            canvas.width = v.videoWidth;
            canvas.height = v.videoHeight;
            ctx.drawImage(v, 0, 0);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
            if (code) handle(code.data);
          }
        } catch {
          /* image illisible : on passe à la suivante */
        }
      }
      raf = requestAnimationFrame(() => void loop());
    };

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false })
      .then((s) => {
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
        void loop();
      })
      .catch(() => setCamera('denied'));
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);

  useEffect(() => input.current?.focus(), []);

  return (
    <div className="scanner">
      <div className="scanner-label">{label}</div>
      {camera === 'on' ? (
        <div className="scanner-video">
          <video ref={video} playsInline muted />
          <div className="scanner-frame" />
          <button type="button" className="btn secondary" onClick={() => setCamera('off')}>
            Fermer la caméra
          </button>
        </div>
      ) : (
        <button type="button" className="btn primary big" onClick={() => setCamera('on')}>
          Scanner
        </button>
      )}
      {camera === 'denied' && <p className="hint warn">Caméra indisponible : utilisez la douchette ou la saisie.</p>}
      <form
        className="scanner-manual"
        onSubmit={(e) => {
          e.preventDefault();
          if (manual.trim()) handle(manual.trim());
          setManual('');
        }}
      >
        <input
          ref={input}
          aria-label={`${label} (douchette ou saisie)`}
          placeholder="Douchette ou saisie du code"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="btn secondary">
          OK
        </button>
      </form>
      {error && (
        <p className="scan-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function typeName(t: QrType) {
  return { A: 'article', U: 'palette', E: 'emplacement' }[t];
}
