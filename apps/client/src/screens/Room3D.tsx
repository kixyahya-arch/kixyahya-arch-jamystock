import { useEffect, useRef, useState } from 'react';
import { layoutRoom, MAX_ITEMS } from '../lib/room-layout';
import type { PackArticle } from '../lib/types';

/**
 * Vue 3D d'une pièce de pack : chaque meuble est un volume à ses vraies dimensions, habillé de sa photo, posé
 * dans une pièce au quadrillage d'un mètre. On tourne autour à la souris ou au doigt. Three.js n'est chargé
 * qu'à l'ouverture de la vue.
 */
export function Room3D({ piece, articles, onCapture }: { piece: string; articles: PackArticle[]; /** enregistre la vue comme visuel de la pièce */ onCapture?: (image: Blob) => Promise<void> }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<{ text: string; x: number; y: number } | null>(null);
  const capture = useRef<(() => Promise<Blob | null>) | null>(null);
  const [saving, setSaving] = useState<'idle' | 'busy' | 'done'>('idle');
  const layout = layoutRoom(articles);
  const estimees = layout.items.filter((i) => i.estimee).length;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      let THREE: typeof import('three');
      let OrbitControls: typeof import('three/examples/jsm/controls/OrbitControls.js').OrbitControls;
      try {
        THREE = await import('three');
        ({ OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js'));
      } catch {
        if (!disposed) setError('La vue 3D n’a pas pu se charger. Rechargez la page.');
        return;
      }
      if (disposed) return;
      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
      } catch {
        setError('Votre navigateur n’affiche pas la 3D (WebGL désactivé).');
        return;
      }
      const css = getComputedStyle(el);
      const color = (v: string, d: string) => css.getPropertyValue(v).trim() || d;
      const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      el.appendChild(renderer.domElement);
      renderer.domElement.setAttribute('aria-hidden', 'true');

      const { width: W, depth: D } = layout;
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(color('--muted-bg', '#eef2f6'));
      const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 100);
      const span = Math.max(W, D);
      camera.position.set(W * 0.15, span * 0.85, D + span * 0.75);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(0, 0.4, D / 2);
      controls.enableDamping = false;
      controls.maxPolarAngle = Math.PI / 2 - 0.05;
      controls.minDistance = 1.5;
      controls.maxDistance = span * 3;
      controls.update();

      scene.add(new THREE.HemisphereLight(0xffffff, dark ? 0x334455 : 0xb9b2a6, 1.1));
      const sun = new THREE.DirectionalLight(0xffffff, 1.6);
      sun.position.set(-W * 0.6, span * 1.4, D * 1.3);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 0.5, far: span * 5 });
      sun.target.position.set(0, 0, D / 2);
      scene.add(sun, sun.target);

      // sol, quadrillage d'un mètre, murs du fond et de gauche
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: dark ? 0x4a3f33 : 0xd9c6a5, roughness: 0.9 }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(0, 0, D / 2);
      floor.receiveShadow = true;
      scene.add(floor);
      // quadrillage d'un mètre, limité au sol de la pièce
      const pts: number[] = [];
      for (let x = -W / 2; x <= W / 2 + 1e-6; x += 1) pts.push(x, 0.003, 0, x, 0.003, D);
      for (let z = 0; z <= D + 1e-6; z += 1) pts.push(-W / 2, 0.003, z, W / 2, 0.003, z);
      const gridGeo = new THREE.BufferGeometry();
      gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      scene.add(new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: 0x6f604b, transparent: true, opacity: 0.3 })));
      const wallMat = new THREE.MeshStandardMaterial({ color: dark ? 0x3b4650 : 0xfaf7f2, roughness: 1, side: THREE.FrontSide });
      // murs vus de l'intérieur seulement : en tournant derrière, ils s'effacent
      const back = new THREE.Mesh(new THREE.PlaneGeometry(W, 2.6), wallMat);
      back.position.set(0, 1.3, 0);
      back.receiveShadow = true;
      const left = new THREE.Mesh(new THREE.PlaneGeometry(D, 2.6), wallMat);
      left.rotation.y = Math.PI / 2;
      left.position.set(-W / 2, 1.3, D / 2);
      left.receiveShadow = true;
      scene.add(back, left);

            const textures: InstanceType<typeof THREE.Texture>[] = [];
      const meshes: InstanceType<typeof THREE.Mesh>[] = [];
      const byId = new Map(articles.map((a) => [a.id, a]));
      const render = () => renderer.render(scene, camera);
      for (const it of layout.items) {
        const a = byId.get(it.id);
        const side = new THREE.MeshStandardMaterial({ color: it.estimee ? 0xb8c2cc : 0x9aa7b4, roughness: 0.75 });
        const front = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
        front.color.set(0x9aa7b4);
        if (a?.vignette) {
          // la photo (ou l'illustration SVG) est posée sur fond blanc, sans déformation, sur la face visible
          const img = new Image();
          img.onload = () => {
            if (disposed) return;
            const ratio = it.w / it.h;
            const cw = ratio >= 1 ? 512 : Math.round(512 * ratio);
            const ch = ratio >= 1 ? Math.round(512 / ratio) : 512;
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(cw, 16);
            canvas.height = Math.max(ch, 16);
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const iw = img.naturalWidth || 512;
            const ih = img.naturalHeight || 512;
            const k = Math.min(canvas.width / iw, canvas.height / ih);
            ctx.drawImage(img, (canvas.width - iw * k) / 2, (canvas.height - ih * k) / 2, iw * k, ih * k);
            const tex = new THREE.CanvasTexture(canvas);
            tex.colorSpace = THREE.SRGBColorSpace;
            textures.push(tex);
            front.map = tex;
            front.color.set(0xffffff);
            front.needsUpdate = true;
            render();
          };
          img.src = a.vignette;
        }
        // faces : +x, -x, +y (dessus), -y, +z (face visible), -z
        const box = new THREE.Mesh(new THREE.BoxGeometry(it.w, it.h, it.d), [side, side, side, side, front, side]);
        box.position.set(it.x, it.h / 2, it.z);
        box.castShadow = true;
        box.receiveShadow = true;
        box.userData = { text: `${a?.libelle ?? 'Bien'}${a?.dimensions ? ` · ${a.dimensions}` : it.estimee ? ' · dimensions inconnues' : ''}` };
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box.geometry), new THREE.LineBasicMaterial({ color: 0x0a2a43, transparent: true, opacity: 0.35 }));
        box.add(edges);
        scene.add(box);
        meshes.push(box);
      }

      const resize = () => {
        const w = el.clientWidth;
        const h = Math.round(Math.min(Math.max(w * 0.62, 260), 520));
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        render();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      resize();
      controls.addEventListener('change', render);
      // la vue courante, en grand format (celui du cadre « ambiance » de la planche, 1600 × 998)
      capture.current = () =>
        new Promise<Blob | null>((resolve) => {
          const w = el.clientWidth;
          const h = renderer.domElement.clientHeight;
          const ratio = renderer.getPixelRatio();
          renderer.setPixelRatio(1);
          renderer.setSize(1600, 998, false);
          camera.aspect = 1600 / 998;
          camera.updateProjectionMatrix();
          renderer.render(scene, camera);
          renderer.domElement.toBlob(
            (b) => {
              renderer.setPixelRatio(ratio);
              renderer.setSize(w, h);
              camera.aspect = w / h;
              camera.updateProjectionMatrix();
              render();
              resolve(b);
            },
            'image/jpeg',
            0.9,
          );
        });

      // nom du meuble survolé (ou touché)
      const ray = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      const pick = (e: PointerEvent) => {
        const r = renderer.domElement.getBoundingClientRect();
        pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(pointer, camera);
        const hit = ray.intersectObjects(meshes, false)[0];
        setHover(hit ? { text: hit.object.userData.text as string, x: e.clientX - r.left, y: e.clientY - r.top } : null);
      };
      const leave = () => setHover(null);
      renderer.domElement.addEventListener('pointermove', pick);
      renderer.domElement.addEventListener('pointerdown', pick);
      renderer.domElement.addEventListener('pointerleave', leave);

      cleanup = () => {
        capture.current = null;
        ro.disconnect();
        controls.dispose();
        renderer.domElement.removeEventListener('pointermove', pick);
        renderer.domElement.removeEventListener('pointerdown', pick);
        renderer.domElement.removeEventListener('pointerleave', leave);
        scene.traverse((o) => {
          const m = o as InstanceType<typeof THREE.Mesh>;
          m.geometry?.dispose();
          const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
          for (const mat of mats) mat.dispose();
        });
        for (const t of textures) t.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
      if (disposed) cleanup();
    })();
    return () => {
      disposed = true;
      cleanup();
    };
    // la scène est reconstruite quand les biens de la pièce changent
  }, [articles.map((a) => `${a.id}:${a.vignette ? 1 : 0}`).join(',')]);

  return (
    <figure className="room-3d">
      <div ref={host} className="room-3d-canvas" role="img" aria-label={`Vue 3D de la pièce ${piece} : ${articles.map((a) => a.libelle).join(', ')}`}>
        {hover && (
          <span className="room-3d-tip" style={{ left: hover.x, top: hover.y }}>
            {hover.text}
          </span>
        )}
      </div>
      {onCapture && !error && (
        <div className="row-actions room-3d-actions">
          <button
            type="button"
            className="btn secondary small"
            disabled={saving === 'busy'}
            onClick={async () => {
              const blob = await capture.current?.();
              if (!blob) return setError('La vue n’a pas pu être enregistrée.');
              setSaving('busy');
              try {
                await onCapture(blob);
                setSaving('done');
              } catch (e) {
                setError((e as Error).message);
                setSaving('idle');
              }
            }}
          >
            {saving === 'busy' ? 'Enregistrement…' : 'Utiliser cette vue comme visuel de la pièce'}
          </button>
          {saving === 'done' && <span className="hint small" role="status">Vue enregistrée : elle figure en tête de pièce et sur la planche.</span>}
        </div>
      )}
      {error ? (
        <p className="small warn-text">{error}</p>
      ) : (
        <figcaption className="hint small">
          Pièce d’environ {fmt(layout.width)} × {fmt(layout.depth)} m, quadrillage d’un mètre. Les meubles sont à leurs dimensions et rangés automatiquement : tournez autour à la souris ou au doigt.
          {estimees ? ` ${estimees} bien${estimees > 1 ? 's' : ''} sans dimensions, montré${estimees > 1 ? 's' : ''} en gris clair à une taille type.` : ''}
          {articles.length > MAX_ITEMS ? ` Seuls les ${MAX_ITEMS} premiers biens sont montrés.` : ''}
        </figcaption>
      )}
    </figure>
  );
}

const fmt = (v: number) => v.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
