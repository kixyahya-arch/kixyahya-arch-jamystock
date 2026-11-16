import { useEffect, useRef, useState } from 'react';
import { uuidv7 } from '@jamystock/domain/browser';
import { compressPhoto } from '../lib/device';

export interface CapturedPhoto {
  photoId: string;
  blob: Blob;
  url: string;
}

interface Props {
  photos: CapturedPhoto[];
  onChange: (photos: CapturedPhoto[]) => void;
  min?: number;
  max?: number;
  label?: string;
}

/** Prise de photo par l'appareil du terminal, compressée localement (REC-02 : 1 à 6 photos). */
export function PhotoCapture({ photos, onChange, min = 1, max = 6, label = 'Photos' }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => () => photos.forEach((p) => URL.revokeObjectURL(p.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const next = [...photos];
      for (const f of Array.from(files).slice(0, max - photos.length)) {
        let blob: Blob = f;
        try {
          blob = await compressPhoto(f);
        } catch {
          /* compression impossible (navigateur ancien) : on garde l'original */
        }
        next.push({ photoId: uuidv7(), blob, url: URL.createObjectURL(blob) });
      }
      onChange(next);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  return (
    <div className="photos">
      <div className="photos-head">
        <span>
          {label} ({photos.length}/{max})
        </span>
        {photos.length < min && <span className="hint warn">{min} minimum</span>}
      </div>
      <div className="photos-grid">
        {photos.map((p) => (
          <figure key={p.photoId}>
            <img src={p.url} alt="" />
            <button type="button" aria-label="Retirer la photo" onClick={() => onChange(photos.filter((x) => x.photoId !== p.photoId))}>
              ×
            </button>
          </figure>
        ))}
        {photos.length < max && (
          <button type="button" className="photo-add" disabled={busy} onClick={() => fileInput.current?.click()}>
            {busy ? '…' : '+ Photo'}
          </button>
        )}
      </div>
      <input ref={fileInput} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => void add(e.target.files)} />
    </div>
  );
}
