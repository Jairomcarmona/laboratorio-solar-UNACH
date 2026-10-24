/* Ayudas 3D contextuales (C19): normal del panel B, rayo incidente, arco del ángulo de incidencia y arco de azimut.
 * Solo geometría ligera (flechas y líneas), sin decoración. Se muestran según la tarea y se pueden ocultar sin perder estado. */
(function () {
  'use strict';
  const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
  const S = LAB.sim.solar;
  const COL = { normal: 0x2fb4ff, ray: 0xffd24a, arc: 0xffffff, az: 0x35d07f };

  LAB.scene.createAids = function (world) {
    const group = new THREE.Group(); group.name = 'ayudas3D'; group.visible = false; world.scene.add(group);
    const Y = V3(0, 1, 0), mat = (c) => new THREE.MeshBasicMaterial({ color: c, depthTest: false, transparent: true, opacity: 0.95 });
    /** Flecha gruesa (cilindro + cono): las líneas de 1 px no se leen en pantallas grandes */
    const arrow = (c, len) => {
      const g = new THREE.Group(), m = mat(c), shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 8), m), head = new THREE.Mesh(new THREE.ConeGeometry(0.095, 0.26, 12), m);
      g.add(shaft, head); g.renderOrder = 20; shaft.renderOrder = head.renderOrder = 20; g.userData = { len, shaft, head };
      g.setDirection = (dir) => { g.quaternion.setFromUnitVectors(Y, dir); const L = g.userData.len; shaft.scale.y = L - 0.26; shaft.position.y = (L - 0.26) / 2; head.position.y = L - 0.13; };
      group.add(g); return g;
    };
    const N = 24;
    const normal = arrow(COL.normal, 1.7), ray = arrow(COL.ray, 2.3);
    /** Arco grueso: tubo que se reconstruye solo cuando cambian los ángulos */
    const mkArc = (c) => { const m = new THREE.Mesh(new THREE.BufferGeometry(), mat(c)); m.renderOrder = 20; m.frustumCulled = false; m.userData.key = ''; group.add(m); return m; };
    const aoiArc = mkArc(COL.arc), azArc = mkArc(COL.az);
    const tag = (txt, cls) => { const el = world.labels.add('aid-' + cls, group, V3(), txt, { cls: 'aid ' + cls }); return el; };
    const tAoi = tag('θ', 'aoi'), tAz = tag('Az', 'az'), tNormal = tag(LAB.t('aids.normal_del_panel'), 'nrm'), tRay = tag(LAB.t('aids.rayo_solar'), 'ray');
    const setText = (el, t) => { const s = el.querySelector('span'); if (s.textContent !== t) s.textContent = t; };
    const origin = V3(), tmp = V3(), base = V3();
    let want = false, shown = false;

    const arcPts = (a, b, r, center) => {
      const ang = Math.acos(Math.max(-1, Math.min(1, a.dot(b)))), pts = [];
      for (let i = 0; i <= N; i++) {
        const t = i / N; let p;
        if (ang < 1e-4) p = a.clone(); else p = a.clone().multiplyScalar(Math.sin((1 - t) * ang) / Math.sin(ang)).add(b.clone().multiplyScalar(Math.sin(t * ang) / Math.sin(ang)));
        pts.push(p.multiplyScalar(r).add(center));
      }
      return pts;
    };
    const setArc = (mesh, a, b, r, center, key) => {
      if (mesh.userData.key === key) return; mesh.userData.key = key;
      const pts = arcPts(a, b, r, center); if (mesh.geometry) mesh.geometry.dispose();
      mesh.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), N, 0.022, 6, false);
    };

    return {
      group, get shown() { return shown; },
      /** mode: 'on' | 'off' | 'auto'; auto = lo que decida la tarea actual (autoWanted) */
      update(tel, mode, autoWanted) {
        want = mode === 'on' || (mode === 'auto' && !!autoWanted);
        if (want !== shown) { shown = want; group.visible = want; for (const t of [tAoi, tAz, tNormal, tRay]) vis(t, want); }
        if (!want) return;
        world.partRoots.moduleB.getWorldPosition(origin);
        const B = tel.B, sun = tel.sun, up = V3(0, 1, 0);
        const n = V3(...S.sunVector(B.az, 90 - B.tilt)).normalize();      // normal: misma convención que el vector solar (azimut del panel, elevación = 90° − inclinación)
        group.position.copy(origin);
        normal.setDirection(n); normal.position.set(0, 0, 0);
        const aoi = B.aoi, sv = V3(...sun.vec).normalize(), up2 = sun.el > 0.5;
        ray.visible = aoi != null && up2; aoiArc.visible = ray.visible; const tight = ray.visible && aoi < 8; vis(tRay, ray.visible && !tight); vis(tAoi, ray.visible); const near = ray.visible && aoi < 25; vis(tNormal, !near);
        if (ray.visible) {
          ray.setDirection(sv.clone().negate()); ray.position.copy(sv).multiplyScalar(2.3);     // el rayo llega desde el Sol hacia el panel
          setArc(aoiArc, n, sv, 1.1, V3(), `${B.az.toFixed(1)}|${B.tilt.toFixed(1)}|${sun.az.toFixed(1)}|${sun.el.toFixed(1)}`);
          tmp.copy(n).add(sv).normalize().multiplyScalar(1.45); setAt(tAoi, tmp);
          setText(tAoi, tight ? LAB.t('aids.el_sol_da_casi', { toFixed: aoi.toFixed(1) }) : (near ? LAB.t('aids.entre_la_normal_del', { toFixed: aoi.toFixed(1) }) : LAB.t('aids.angulo_de_incidencia', { toFixed: aoi.toFixed(1) })));
          setAt(tRay, V3().copy(sv).multiplyScalar(2.5));
        }
        setAt(tNormal, V3().copy(n).multiplyScalar(1.85));
        // arco de azimut sobre el suelo, centrado en el pedestal: del norte al azimut del panel (se parametriza por ángulo; con 180° una interpolación esférica es degenerada)
        base.copy(world.trackerB.group.getWorldPosition(tmp)); base.y = 0.06;
        const rel = V3().subVectors(base, origin);
        const keyAz = `${B.az.toFixed(1)}|${rel.x.toFixed(2)}|${rel.z.toFixed(2)}`;
        if (azArc.userData.key !== keyAz) {
          azArc.userData.key = keyAz;
          const pts = []; for (let i = 0; i <= N; i++) pts.push(V3(...S.sunVector(B.az * i / N, 0)).multiplyScalar(1.1).add(rel));
          if (azArc.geometry) azArc.geometry.dispose(); azArc.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), N, 0.022, 6, false);
        }
        setAt(tAz, V3(...S.sunVector(B.az / 2, 0)).multiplyScalar(1.45).add(rel));
        setText(tAz, LAB.t('aids.az_inclinacion', { toFixed: B.az.toFixed(0), toFixed2: B.tilt.toFixed(0) }));
        setText(tNormal, LAB.t('aids.normal_del_panel')); setText(tRay, LAB.t('aids.rayo_solar'));
        void up;
      },
    };
    function vis(el, on) { const it = world.labels.items.find((i) => i.el === el); if (it) it.obj.visible = on; }
    function setAt(el, p) { const it = world.labels.items.find((i) => i.el === el); if (it) it.obj.position.copy(p); }
  };
})();
