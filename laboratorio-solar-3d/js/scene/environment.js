/* Entorno: azotea, edificios y vegetacion circundantes, cielo fisico, estrellas, Sol/luces, nubes y lluvia. */
(function () {
  'use strict';
  const { clamp, lerp, smoothstep, col, D2R } = LAB.util;
  const T = LAB.scene.tex;
  const rf = LAB.config.layout.roof;

  /** El shader Sky de r128 entrega color ya "con gamma"; lo devolvemos a lineal para el pipeline HDR */
  function patchSky(sky) {
    const m = sky.material;
    m.fragmentShader = 'uniform float skyGain;\n' + m.fragmentShader.replace('gl_FragColor = vec4( retColor, 1.0 );',
      'gl_FragColor = vec4( min( pow( retColor, vec3( 2.2 ) ) * skyGain, vec3( 5.0 ) ), 1.0 );');
    m.uniforms.skyGain = { value: 1.0 };
    m.needsUpdate = true;
  }

  class Environment {
    constructor(scene, renderer) {
      this.scene = scene; this.renderer = renderer;
      this.group = new THREE.Group(); scene.add(this.group);
      this.buildRoof();
      this.buildSurroundings();
      this.buildSky();
      this.buildLights();
      this.buildClouds();
      this.buildRain();
      this.lastEnv = { el: 99, cloud: -1, t: -9 };
      this.sunVec = new THREE.Vector3(0, 1, 0);
      this.dayFactor = 1;
      scene.fog = new THREE.FogExp2(0x9fb8d0, 0.0011);
    }

    // ---------------------------------------------------------------- azotea
    buildRoof() {
      const g = this.group;
      const tex = T.concrete([8, 5.5]);
      const bump = tex.clone(); bump.needsUpdate = true;
      const roofMat = T.std({ color: 0xffffff, map: tex, bumpMap: bump, bumpScale: 0.22, roughness: 0.92, metalness: 0.0, envMapIntensity: 0.6 });
      const slab = new THREE.Mesh(new THREE.BoxGeometry(rf.w, rf.h, rf.d), roofMat);
      slab.position.set(0, -rf.h / 2, 0); slab.receiveShadow = true; slab.castShadow = true;
      g.add(slab);
      this.slab = slab;

      // pretil perimetral
      const wallMat = T.std({ color: 0xd9d6cf, roughness: 0.85, envMapIntensity: 0.6 });
      const capMat = T.std({ color: 0xb7b4ad, roughness: 0.8, envMapIntensity: 0.6 });
      const h = 0.95, t = 0.28;
      const mk = (w, d, x, z) => {
        T.box(g, w, h, d, wallMat, x, h / 2, z);
        T.box(g, w + 0.06, 0.07, d + 0.06, capMat, x, h + 0.035, z);
      };
      mk(rf.w, t, 0, -rf.d / 2 + t / 2);
      mk(rf.w, t, 0, rf.d / 2 - t / 2);
      mk(t, rf.d - 2 * t, -rf.w / 2 + t / 2, 0);
      mk(t, rf.d - 2 * t, rf.w / 2 - t / 2, 0);
      // franja institucional en la fachada sur
      const stripe = T.std({ color: LAB.config.colors.uni, roughness: 0.6, envMapIntensity: 0.6 });
      T.box(g, rf.w, 0.14, 0.02, stripe, 0, 0.45, rf.d / 2 - 0.0);

      // banner institucional pintado sobre el piso, al frente de la azotea: fuera del paso de los equipos, las camaras y el pasillo
      if (LAB.ui && LAB.ui.logoBannerDataUri) {
        const img = new Image(), bw = 11, bh = bw * 101 / 1246;
        const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh), mat);
        mesh.rotation.x = -Math.PI / 2; mesh.position.set(0, 0.03, 7.7); mesh.name = 'logoBanner'; mesh.renderOrder = 1;
        img.onload = () => { const t = new THREE.Texture(img); t.encoding = THREE.sRGBEncoding; t.anisotropy = 8; t.needsUpdate = true; mat.map = t; mat.opacity = 0.92; mat.needsUpdate = true; };
        img.src = LAB.ui.logoBannerDataUri;
        g.add(mesh); this.logoBanner = mesh;
      }

      // elementos tipicos de azotea
      const metal = T.std({ color: 0x9aa3ab, roughness: 0.45, metalness: 0.7 });
      const dark = T.std({ color: 0x2b3036, roughness: 0.6, metalness: 0.3 });
      // tinacos
      for (const [x, z] of [[10.6, -6.4], [9.0, -6.7]]) {
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 1.15, 28), T.std({ color: 0xe9e4da, roughness: 0.5 }));
        tank.position.set(x, 0.58 + 0.3, z); tank.castShadow = tank.receiveShadow = true; g.add(tank);
        const lid = new THREE.Mesh(new THREE.SphereGeometry(0.62, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2), T.std({ color: 0xe9e4da, roughness: 0.5 }));
        lid.scale.y = 0.45; lid.position.set(x, 0.3 + 1.15 + 0.58, z); lid.castShadow = true; g.add(lid);
        T.box(g, 1.4, 0.3, 1.4, T.std({ color: 0x9c9a94, roughness: 0.9 }), x, 0.15, z);
      }
      // caseta de escalera
      const stair = T.box(g, 3.2, 2.7, 3.0, T.std({ color: 0xcfcac0, roughness: 0.85 }), -10.6, 1.35, -5.9);
      T.box(g, 1.1, 2.0, 0.06, dark, -10.6, 1.0, -5.9 + 1.52);
      T.box(g, 3.4, 0.14, 3.2, capMat, -10.6, 2.77, -5.9);
      // unidades de aire acondicionado
      for (let i = 0; i < 3; i++) {
        const ac = T.box(g, 1.0, 0.9, 0.7, metal, 11.0 + (i % 2) * 1.2, 0.45, 6.6 - Math.floor(i / 2) * 1.6);   // al fondo este: libres del pie de la camara IP 2
        const fan = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.04, 20), dark);
        fan.position.set(ac.position.x, 0.92, ac.position.z); g.add(fan);
      }
      // linea de vida, tubos y pasillo de mantenimiento
      const walk = T.std({ color: 0x6d7378, roughness: 0.95 });
      T.box(g, 12.5, 0.015, 1.0, walk, 0, 0.008, 5.8);
      for (let i = -6; i <= 6; i++) T.box(g, 0.05, 0.02, 1.0, T.std({ color: 0xe8c33a, roughness: 0.8 }), i * 1.0, 0.012, 5.8);
      // luminarias (se encienden de noche)
      this.lamps = []; this.lampLights = [];
      for (const [x, z] of [[-11.5, 7.6], [11.5, 7.6], [-11.5, -7.6], [11.5, -7.6]]) {
        const pole = T.strut(g, new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 3.4, z), 0.04, metal);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.25), T.std({ color: 0xffffff, emissive: 0xffe2a6, emissiveIntensity: 0, roughness: 0.4 }));
        head.position.set(x, 3.45, z); g.add(head);
        this.lamps.push(head);
        const pl = new THREE.PointLight(0xffe2b0, 0, 16, 2); pl.position.set(x, 3.3, z); g.add(pl); this.lampLights.push(pl);
      }
    }

    // ------------------------------------------------------ entorno lejano
    buildSurroundings() {
      const g = this.group;
      const gy = -13;                                            // nivel de suelo bajo la azotea
      const r = T.rng(5);
      // suelo con vegetacion y calles
      const gtex = T.canvasTexture(1024, 1024, (ctx, w, h) => {
        ctx.fillStyle = '#4d6b3c'; ctx.fillRect(0, 0, w, h);
        for (let i = 0; i < 1600; i++) {
          ctx.fillStyle = `rgba(${40 + r() * 50},${80 + r() * 70},${30 + r() * 40},${0.25 + r() * 0.3})`;
          const s = 6 + r() * 40; ctx.beginPath(); ctx.arc(r() * w, r() * h, s, 0, 6.3); ctx.fill();
        }
        ctx.strokeStyle = '#5a5d60'; ctx.lineWidth = 34;       // calles
        ctx.beginPath(); ctx.moveTo(0, 300); ctx.lineTo(w, 360); ctx.moveTo(620, 0); ctx.lineTo(560, h); ctx.stroke();
        ctx.strokeStyle = '#c9c4a8'; ctx.lineWidth = 3; ctx.setLineDash([22, 18]);
        ctx.beginPath(); ctx.moveTo(0, 300); ctx.lineTo(w, 360); ctx.moveTo(620, 0); ctx.lineTo(560, h); ctx.stroke();
      }, { repeat: [10, 10] });
      const ground = new THREE.Mesh(new THREE.CircleGeometry(1400, 48), T.std({ color: 0xffffff, map: gtex, roughness: 1, envMapIntensity: 0.5 }));
      ground.rotation.x = -Math.PI / 2; ground.position.y = gy; ground.receiveShadow = true; g.add(ground);

      // arbolado (instanciado)
      const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 3.2, 6);
      const leafGeo = new THREE.IcosahedronGeometry(1, 1);
      const N = 520;
      const trunks = new THREE.InstancedMesh(trunkGeo, T.std({ color: 0x5b4632, roughness: 1 }), N);
      const leaves = new THREE.InstancedMesh(leafGeo, T.std({ color: 0xffffff, roughness: 0.9, envMapIntensity: 0.7 }), N);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
      for (let i = 0; i < N; i++) {
        const ang = r() * Math.PI * 2, dist = 46 + Math.pow(r(), 0.7) * 520;
        const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
        if (Math.abs(x) < 24 && Math.abs(z) < 18) { i--; continue; }       // dejar libre bajo el edificio
        const sc = 2.4 + r() * 2.6;
        p.set(x, gy + 1.6 * (sc / 4), z); s.set(1, sc / 4, 1); m4.compose(p, q, s); trunks.setMatrixAt(i, m4);
        p.set(x, gy + sc * 1.7, z); s.set(sc * 0.8, sc * 0.9, sc * 0.8); m4.compose(p, q, s); leaves.setMatrixAt(i, m4);
        leaves.setColorAt(i, col(new THREE.Color().setHSL(0.24 + r() * 0.07, 0.45, 0.2 + r() * 0.12).getHex()));
      }
      trunks.castShadow = leaves.castShadow = true; leaves.receiveShadow = true;
      g.add(trunks, leaves);

      // edificios de la facultad y ciudad
      const bmat = T.std({ color: 0xcdc8bd, roughness: 0.9, envMapIntensity: 0.6 });
      const winTex = T.canvasTexture(256, 256, (ctx, w, h) => {
        ctx.fillStyle = '#d4cfc3'; ctx.fillRect(0, 0, w, h);
        for (let y = 20; y < h; y += 64) for (let x = 12; x < w; x += 44) { ctx.fillStyle = '#334a5f'; ctx.fillRect(x, y, 30, 34); }
      }, { repeat: [3, 1] });
      const winMask = T.canvasTexture(256, 256, (ctx, w, h) => {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
        for (let y = 20; y < h; y += 64) for (let x = 12; x < w; x += 44) { ctx.fillStyle = '#fff'; ctx.fillRect(x, y, 30, 34); }
      }, { repeat: [3, 1] });
      this.windowMats = [];
      const blds = [[-42, -6, 24, 11, 14, 0], [48, -20, 30, 14, 16, 0.2], [20, -60, 40, 9, 22, 0], [-70, 40, 26, 16, 20, 0.1], [80, 50, 32, 12, 18, 0],
        [-20, 70, 36, 8, 14, 0], [10, 120, 60, 20, 18, 0], [-120, -80, 50, 18, 26, 0.3], [140, -100, 54, 24, 30, 0.2], [-160, 30, 44, 14, 20, 0]];
      for (const [x, z, w, h, d, rot] of blds) {
        const rep = [Math.max(2, Math.round(w / 8)), Math.max(1, Math.round(h / 8))];
        const em = winMask.clone(); em.needsUpdate = true; em.repeat.set(...rep);
        const wm = T.std({ color: 0xffffff, map: winTex.clone(), emissiveMap: em, roughness: 0.8, emissive: 0xffd27a, emissiveIntensity: 0, envMapIntensity: 0.6 });
        wm.map.needsUpdate = true; wm.map.repeat.set(...rep);
        this.windowMats.push(wm);
        const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wm);
        b.position.set(x, gy + h / 2, z); b.rotation.y = rot; b.castShadow = b.receiveShadow = true; g.add(b);
      }

      // sierra al horizonte (anillo con silueta de montanas)
      const seg = 160, geo = new THREE.CylinderGeometry(1250, 1250, 1, seg, 1, true);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const a = Math.atan2(pos.getZ(i), pos.getX(i));
        const top = pos.getY(i) > 0;
        const n = Math.sin(a * 3 + 1.2) * 0.5 + Math.sin(a * 7 + 0.3) * 0.28 + Math.sin(a * 17 + 2.1) * 0.12 + Math.sin(a * 41) * 0.05;
        pos.setY(i, top ? 40 + (n + 0.7) * 95 : -60);
      }
      geo.computeVertexNormals();
      const mtn = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col(0x3d5a49), side: THREE.BackSide, fog: true }));
      mtn.position.y = gy; g.add(mtn);
      this.mountains = mtn;
    }

    // ------------------------------------------------------------- cielo
    buildSky() {
      const sky = new THREE.Sky();
      sky.scale.setScalar(2000);
      sky.frustumCulled = false;
      patchSky(sky);
      this.scene.add(sky);
      this.sky = sky;
      const u = sky.material.uniforms;
      u.turbidity.value = 3.2; u.rayleigh.value = 1.3; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.82;
      // escena auxiliar para generar el mapa de entorno (IBL)
      this.skyScene = new THREE.Scene();
      this.skyClone = new THREE.Sky(); this.skyClone.scale.setScalar(2000); this.skyClone.frustumCulled = false;
      patchSky(this.skyClone);
      this.skyScene.add(this.skyClone);
      this.pmrem = new THREE.PMREMGenerator(this.renderer);
      this.pmrem.compileCubemapShader();
      this.envRT = null;

      // estrellas
      const r = T.rng(99), n = 1800, pts = new Float32Array(n * 3), cols = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const u1 = r() * 2 - 1, th = r() * Math.PI * 2, s = Math.sqrt(1 - u1 * u1);
        pts.set([s * Math.cos(th) * 900, Math.abs(u1) * 900 * 0.98 + 10, s * Math.sin(th) * 900], i * 3);
        const b = 0.5 + r() * 0.5; cols.set([b, b, b * (0.9 + r() * 0.1)], i * 3);
      }
      const sg = new THREE.BufferGeometry();
      sg.setAttribute('position', new THREE.BufferAttribute(pts, 3)); sg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ size: 2.2, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false }));
      this.stars.frustumCulled = false;
      this.scene.add(this.stars);
    }

    // ------------------------------------------------------------- luces
    buildLights() {
      const sun = new THREE.DirectionalLight(0xffffff, 3);
      sun.castShadow = true;
      const s = sun.shadow;
      s.mapSize.set(4096, 4096);
      s.camera.left = -13; s.camera.right = 13; s.camera.top = 11; s.camera.bottom = -11;
      s.camera.near = 5; s.camera.far = 90;
      s.bias = -0.0004; s.normalBias = 0.03; s.radius = 2.2;
      this.sun = sun;
      this.scene.add(sun, sun.target);
      sun.target.position.set(0, 0.8, 0);
      this.hemi = new THREE.HemisphereLight(0xbcd6ff, 0x6b665c, 0.12);
      this.scene.add(this.hemi);
      this.moon = new THREE.DirectionalLight(0x9db4ff, 0);
      this.scene.add(this.moon);
    }

    // -------------------------------------------------------------- nubes
    buildClouds() {
      const tex = T.canvasTexture(256, 128, (ctx, w, h) => {
        const r = T.rng(11);
        ctx.clearRect(0, 0, w, h);
        for (let i = 0; i < 26; i++) {
          const x = w * (0.18 + r() * 0.64), y = h * (0.45 + r() * 0.2), rad = 18 + r() * 30;
          const gr = ctx.createRadialGradient(x, y, 0, x, y, rad);
          gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = gr; ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
        }
      });
      this.clouds = [];
      const r = T.rng(3);
      this.cloudGroup = new THREE.Group(); this.scene.add(this.cloudGroup);
      for (let i = 0; i < 46; i++) {
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0, fog: false });
        const sp = new THREE.Sprite(mat);
        const ang = r() * Math.PI * 2, dist = 120 + r() * 620;
        sp.position.set(Math.cos(ang) * dist, 90 + r() * 140, Math.sin(ang) * dist);
        const sc = 170 + r() * 260; sp.scale.set(sc, sc * 0.5, 1);
        sp.userData = { rank: r(), speed: 0.6 + r() * 0.8, base: sp.position.clone() };
        this.cloudGroup.add(sp); this.clouds.push(sp);
      }
    }

    // -------------------------------------------------------------- lluvia
    buildRain() {
      const n = 1800, pos = new Float32Array(n * 6);
      this.rainN = n; this.rainSeed = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        this.rainSeed[i * 3] = (Math.random() - 0.5) * 34; this.rainSeed[i * 3 + 1] = Math.random() * 14; this.rainSeed[i * 3 + 2] = (Math.random() - 0.5) * 26;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.rain = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: col(0xbfd3e8), transparent: true, opacity: 0.0, fog: true, depthWrite: false }));
      this.rain.frustumCulled = false; this.rain.visible = false;
      this.scene.add(this.rain);
      this.rainT = 0;
    }

    updateRain(dt, level, wind, windDir) {
      const R = LAB.sim.RAIN_LEVELS[level || 0];
      const m = this.rain.material;
      m.opacity += (R.op - m.opacity) * Math.min(1, dt * 2);
      this.rain.geometry.setDrawRange(0, Math.max(2, Math.round(this.rainN * R.frac)) * 2);
      this.rain.visible = m.opacity > 0.01;
      if (!this.rain.visible) return;
      this.rainT += dt;
      const a = this.rain.geometry.attributes.position.array, s = this.rainSeed;
      const dx = -Math.sin(windDir * D2R) * Math.min(wind, 15) * 0.05 * -1, dz = Math.cos(windDir * D2R) * Math.min(wind, 15) * 0.05 * -1;
      for (let i = 0; i < this.rainN; i++) {
        const y = 14 - ((s[i * 3 + 1] + this.rainT * R.fall) % 14);
        const x = s[i * 3], z = s[i * 3 + 2];
        a.set([x, y, z, x + dx, y + R.len, z + dz], i * 6);
      }
      this.rain.geometry.attributes.position.needsUpdate = true;
    }

    // ------------------------------------------------------ actualizacion
    update(tel, dt) {
      const sun = tel.sun, env = tel.env;
      const el = sun.el;
      this.sunVec.set(sun.vec[0], sun.vec[1], sun.vec[2]);
      const dayF = smoothstep(-6, 8, el);               // 0 noche .. 1 dia
      const twil = 1 - smoothstep(0, 22, Math.abs(el));  // calidez cerca del horizonte
      this.dayFactor = dayF;
      const cloud = env.cloud;
      const dniF = clamp(env.dni / 900, 0, 1.15);

      // luz solar: directa segun DNI real simulado; cambia de color cerca del horizonte
      const warm = new THREE.Color().setHSL(0.09 - 0.02 * twil, 0.35 + 0.5 * twil, 0.95 - 0.28 * twil);
      this.sun.color.copy(warm.convertSRGBToLinear());
      this.sun.intensity = 2.1 * dniF * smoothstep(-1, 6, el) + 0.0001;
      this.sun.position.copy(this.sunVec).multiplyScalar(60).add(this.sun.target.position);
      this.sun.visible = this.sun.intensity > 0.01;
      this.sun.castShadow = el > 1.5 && dniF > 0.03;

      // luz de luna / noche
      this.moon.intensity = 0.28 * (1 - dayF);
      this.moon.position.set(-30, 40, 25);

      // cielo
      const u = this.sky.material.uniforms, uc = this.skyClone.material.uniforms;
      for (const uu of [u, uc]) {
        uu.sunPosition.value.copy(this.sunVec);
        uu.turbidity.value = lerp(1.8, 12, Math.pow(cloud, 0.8)) + twil * 3;
        uu.rayleigh.value = lerp(3.4, 0.6, cloud) + twil * 1.4;
        uu.mieCoefficient.value = lerp(0.002, 0.03, cloud);
        uu.mieDirectionalG.value = 0.8;
        uu.skyGain.value = lerp(0.16, 0.13, cloud);
      }
      // la luminosidad la gestionamos escalando el entorno y la niebla
      const skyCol = new THREE.Color().setHSL(0.58, 0.45, 0.62 * lerp(0.2, 1, dayF) * lerp(1, 0.78, cloud));
      skyCol.lerp(new THREE.Color(0xf0b28a), twil * 0.55 * dayF);
      const fogCol = skyCol.clone().multiplyScalar(0.9);
      this.scene.fog.color.copy(fogCol.convertSRGBToLinear ? fogCol.convertSRGBToLinear() : fogCol);
      this.scene.fog.density = 0.0010 + 0.0012 * cloud + 0.0006 * (env.rainLevel || 0);
      this.mountains.material.color.copy(col(0x3d5a49)).multiplyScalar(lerp(0.05, 1, dayF));

      // ambiente: mas difuso y mas azul con nubes
      this.hemi.intensity = (0.02 + 0.2 * dayF) * lerp(0.9, 1.4, cloud);
      this.hemi.color.copy(col(0xbcd6ff)); this.hemi.groundColor.copy(col(0x6b665c));
      for (const m of T.registry) m.envMapIntensity = (m.userData.baseEnv || 1) * (0.05 + 0.95 * dayF) * lerp(1.0, 0.8, cloud);

      // estrellas y luces nocturnas
      this.stars.material.opacity = clamp((0.35 - dayF) * 2.4, 0, 1) * (1 - cloud * 0.9);
      const nightL = 1 - smoothstep(-8, 2, el);
      this.lamps.forEach((l) => { l.material.emissiveIntensity = 2.2 * nightL; });
      this.windowMats.forEach((m) => { m.emissiveIntensity = 1.1 * nightL; m.emissive.copy(col(0xffd27a)); });
      this.lampLights.forEach((l) => { l.intensity = 1.6 * nightL; });

      // mapa de entorno para reflejos (limitado en frecuencia)
      const le = this.lastEnv;
      if (Math.abs(le.el - el) > 0.5 || Math.abs(le.cloud - cloud) > 0.05 || this.envRT == null) {
        le.el = el; le.cloud = cloud;
        this.refreshEnvironment();
      }

      // nubes: cobertura ~ fraccion de cielo, derivan con el viento
      const cover = clamp(cloud, 0, 1);
      const shade = lerp(0.32, 1, dayF) * lerp(1, 0.55, cover);
      const cc = new THREE.Color().setRGB(shade, shade, shade * 1.03);
      cc.lerp(new THREE.Color(1.0, 0.7, 0.5), twil * 0.5 * dayF);
      for (const sp of this.clouds) {
        const want = clamp((cover - sp.userData.rank * 0.95) * 4.5, 0, 1) * 0.9;
        sp.material.opacity += (want - sp.material.opacity) * Math.min(1, dt * 1.5);
        sp.material.color.copy(cc);
        const d = (env.wind * 0.35 + 0.6) * sp.userData.speed * dt;
        sp.position.x += d * 0.9; sp.position.z += d * 0.25;
        if (sp.position.x > 760) sp.position.x -= 1500;
      }

      this.updateRain(dt, env.rainLevel, env.wind, env.windDir);
    }

    refreshEnvironment() {
      const u = this.skyClone.material.uniforms;
      if (this.envRT) this.envRT.dispose();
      this.envRT = this.pmrem.fromScene(this.skyScene, 0.0, 0.1, 3000);
      this.scene.environment = this.envRT.texture;
      void u;
    }
  }

  LAB.scene.Environment = Environment;
})();
