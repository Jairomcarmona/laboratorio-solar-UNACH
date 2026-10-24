/* Texturas procedurales (canvas) y utilidades de geometria compartidas por la escena. Sin archivos externos. */
(function () {
  'use strict';
  const { col } = LAB.util;

  /** Fabrica de materiales: registra los estandar para poder escalar la iluminacion ambiental globalmente */
  const registry = new Set();
  function std(opts, physical = false) {
    const o = Object.assign({}, opts);
    if (typeof o.color === 'number') o.color = col(o.color);
    if (typeof o.emissive === 'number') o.emissive = col(o.emissive);
    const m = physical ? new THREE.MeshPhysicalMaterial(o) : new THREE.MeshStandardMaterial(o);
    m.userData.baseEnv = o.envMapIntensity != null ? o.envMapIntensity : 1;
    registry.add(m);
    return m;
  }

  function canvasTexture(w, h, draw, opts = {}) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    draw(ctx, w, h);
    const t = new THREE.CanvasTexture(c);
    t.anisotropy = opts.anisotropy || 8;
    if (opts.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(opts.repeat[0], opts.repeat[1]); }
    t.encoding = opts.linear ? THREE.LinearEncoding : THREE.sRGBEncoding;
    return t;
  }

  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  /** Concreto con juntas, manchas y granulado */
  function concrete(repeat, tone = 112) {
    const r = rng(7);
    return canvasTexture(1024, 1024, (ctx, w, h) => {
      ctx.fillStyle = `rgb(${tone},${tone + 2},${tone})`;
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 90; i++) {                      // manchas suaves
        const x = r() * w, y = r() * h, rad = 40 + r() * 160;
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
        const d = (r() - 0.5) * 26;
        g.addColorStop(0, `rgba(${tone + d},${tone + d},${tone + d},0.14)`);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
      }
      const img = ctx.getImageData(0, 0, w, h); const px = img.data;  // granulado
      for (let i = 0; i < px.length; i += 4) { const n = (r() - 0.5) * 22; px[i] += n; px[i + 1] += n; px[i + 2] += n; }
      ctx.putImageData(img, 0, 0);
      ctx.strokeStyle = 'rgba(40,42,44,0.55)'; ctx.lineWidth = 3;     // juntas de colado
      ctx.strokeRect(1.5, 1.5, w - 3, h - 3);
      ctx.strokeStyle = 'rgba(40,42,44,0.25)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    }, { repeat });
  }

  /** Cara frontal del modulo FV: celdas monocristalinas con barras colectoras */
  function pvCells(cols, rows) {
    const r = rng(21);
    return canvasTexture(2048, 1024, (ctx, w, h) => {
      ctx.fillStyle = '#0a1522'; ctx.fillRect(0, 0, w, h);                    // fondo (backsheet negro)
      const mx = 34, my = 34, gap = 5;
      const cw = (w - mx * 2 - gap * (cols - 1)) / cols, ch = (h - my * 2 - gap * (rows - 1)) / rows;
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const x = mx + i * (cw + gap), y = my + j * (ch + gap);
        const v = (r() - 0.5) * 10;
        const g = ctx.createLinearGradient(x, y, x + cw, y + ch);
        g.addColorStop(0, `rgb(${18 + v},${46 + v},${96 + v})`);
        g.addColorStop(0.5, `rgb(${24 + v},${60 + v},${116 + v})`);
        g.addColorStop(1, `rgb(${16 + v},${42 + v},${88 + v})`);
        ctx.fillStyle = g;
        const c = 7;                                                        // esquinas recortadas
        ctx.beginPath();
        ctx.moveTo(x + c, y); ctx.lineTo(x + cw - c, y); ctx.lineTo(x + cw, y + c); ctx.lineTo(x + cw, y + ch - c);
        ctx.lineTo(x + cw - c, y + ch); ctx.lineTo(x + c, y + ch); ctx.lineTo(x, y + ch - c); ctx.lineTo(x, y + c);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(170,190,215,0.55)'; ctx.lineWidth = 1.4;     // barras colectoras
        for (let b = 1; b <= 4; b++) { const bx = x + (cw * b) / 5; ctx.beginPath(); ctx.moveTo(bx, y + 3); ctx.lineTo(bx, y + ch - 3); ctx.stroke(); }
        ctx.strokeStyle = 'rgba(120,150,190,0.12)'; ctx.lineWidth = 0.8;     // dedos
        for (let f = 1; f < 22; f++) { const fy = y + (ch * f) / 22; ctx.beginPath(); ctx.moveTo(x, fy); ctx.lineTo(x + cw, fy); ctx.stroke(); }
      }
    }, { anisotropy: 16 });
  }

  /** Cilindro/prisma orientado entre dos puntos (para soportes, cables y actuadores) */
  const UP = new THREE.Vector3(0, 1, 0);
  function placeStrut(mesh, a, b, radiusScale) {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    mesh.position.copy(a).addScaledVector(d, 0.5);
    mesh.quaternion.setFromUnitVectors(UP, d.normalize());
    mesh.scale.set(radiusScale != null ? radiusScale : mesh.scale.x, len, radiusScale != null ? radiusScale : mesh.scale.z);
  }
  function strut(parent, a, b, radius, material) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 12), material);
    m.castShadow = true; m.receiveShadow = true;
    placeStrut(m, a, b, 1);
    parent.add(m);
    return m;
  }
  function box(parent, w, h, d, material, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  /** Texto en canvas para letreros y pantallas */
  function textTexture(w, h, draw) { return canvasTexture(w, h, draw, { anisotropy: 4 }); }

  LAB.scene.tex = { std, registry, canvasTexture, concrete, pvCells, placeStrut, strut, box, textTexture, rng };
})();
