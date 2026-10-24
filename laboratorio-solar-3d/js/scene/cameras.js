/* Camara principal: navegacion orbital, vistas predefinidas con transicion suave y modo "camara IP" (POV). */
(function () {
  'use strict';
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  /** Esquinas de una caja {min,max} */
  const corners = (b) => { const o = []; for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) o.push(V3(x, y, z)); return o; };

  /** Distancia desde `target` a lo largo de `dir` (unitario, del objetivo hacia la camara) para que TODOS los puntos
   *  entren en el cuadro con margen, segun la relacion de aspecto real del escenario. `top` es la fraccion de alto que
   *  la interfaz (barra de vistas) ocupa arriba: esa franja se deja libre. */
  function fitDistance(points, target, dir, fovDeg, aspect, o = {}) {
    const fwd = dir.clone().negate().normalize();
    const right = V3().crossVectors(fwd, V3(0, 1, 0)).normalize();
    const up = V3().crossVectors(right, fwd).normalize();
    const tv = Math.tan(fovDeg * Math.PI / 360), th = tv * aspect;
    const m = o.margin || 1.08, top = Math.max(0, Math.min(0.5, o.top || 0));
    let d = o.minDist || 2;
    for (const p of points) {
      const v = p.clone().sub(target), a = v.dot(fwd), x = Math.abs(v.dot(right)), y = v.dot(up);
      d = Math.max(d, x * m / th - a, y >= 0 ? y * m / (tv * (1 - 2 * top)) - a : -y * m / tv - a);
    }
    return d;
  }
  /** Coordenadas normalizadas (-1..1) de un punto en una camara: {x, y, z} con z<1 delante */
  const ndc = (cam, p) => { cam.updateMatrixWorld(true); cam.updateProjectionMatrix(); return p.clone().project(cam); };

  class CameraRig {
    constructor(camera, dom, world) {
      this.camera = camera; this.world = world; this.dom = dom;
      this.controls = new THREE.OrbitControls(camera, dom);
      const c = this.controls;
      c.enableDamping = true; c.dampingFactor = 0.07;
      c.minDistance = 1.6; c.maxDistance = 55;
      c.maxPolarAngle = Math.PI * 0.492; c.minPolarAngle = 0.05;
      c.rotateSpeed = 0.7; c.zoomSpeed = 0.9; c.panSpeed = 0.7;
      c.screenSpacePanning = false;
      this.tween = null;
      this.pov = null;
      this.saved = null;
      this.view = 'general';
      this.autoOrbit = false;
      this.moved = false;
      c.addEventListener('start', () => { this.moved = true; if (this.tween) this.tween = null; });
      this.set('general', true);
    }

    set(name, instant = false) {
      const v = this.world.viewPose(name, this.camera.aspect); if (!v) return;
      this.view = name; this.moved = false;
      this.exitPov(true);
      if (instant) {
        this.camera.position.set(...v.pos); this.controls.target.set(...v.target); this.camera.fov = v.fov; this.camera.updateProjectionMatrix();
        this.controls.update(); return;
      }
      this.tween = {
        t: 0, dur: 1.6, p0: this.camera.position.clone(), p1: V3(...v.pos), t0: this.controls.target.clone(), t1: V3(...v.target),
        f0: this.camera.fov, f1: v.fov,
      };
    }

    /** Tras un cambio del area util (tamano de la ventana, barra de vistas): vuelve a encuadrar la vista predefinida
     *  que este activa, salvo que la persona ya haya movido la camara. Las posiciones fisicas no cambian. */
    refit() {
      if (!this.view || this.moved || this.free || this.pov) return;
      const v = this.world.viewPose(this.view, this.camera.aspect); if (!v) return;
      if (this.tween) { this.tween.p1.set(...v.pos); this.tween.t1.set(...v.target); this.tween.f1 = v.fov; return; }
      this.camera.position.set(...v.pos); this.controls.target.set(...v.target); this.camera.fov = v.fov; this.camera.updateProjectionMatrix();
      this.controls.update();
    }

    /** Camara libre (estilo "modo desarrollador"): vuelo con W A S D, Q/E y arrastre para mirar */
    setFree(on) {
      if (on === !!this.free) return;
      if (on) {
        this.exitPov(true); this.tween = null; this.autoOrbit = false;
        const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
        this.fy = e.y; this.fx = e.x; this.speed = 6; this.keys = {};
        this.free = true; this.controls.enabled = false;
        // Teclado: ignora controles interactivos y combinaciones con Ctrl/Meta/Alt; suelta todas las teclas al perder el foco (C10)
        this._kd = (ev) => { if (ev.ctrlKey || ev.metaKey || ev.altKey || LAB.util.isInteractive(ev.target)) return; this.keys[ev.code] = true; };
        this._ku = (ev) => { this.keys[ev.code] = false; };
        this._clr = () => { this.keys = {}; this.drag = null; };
        window.addEventListener('blur', this._clr); document.addEventListener('visibilitychange', this._clr);
        this._md = (ev) => { if (ev.button === 0 || ev.button === 2) { this.drag = { x: ev.clientX, y: ev.clientY }; } };
        this._mm = (ev) => { if (!this.drag) return; this.fy -= (ev.clientX - this.drag.x) * 0.004; this.fx = Math.max(-1.5, Math.min(1.5, this.fx - (ev.clientY - this.drag.y) * 0.004)); this.drag = { x: ev.clientX, y: ev.clientY }; };
        this._mu = () => { this.drag = null; };
        this._wh = (ev) => { ev.preventDefault(); this.speed = Math.max(0.5, Math.min(40, this.speed * (ev.deltaY < 0 ? 1.15 : 1 / 1.15))); };
        this._cm = (ev) => ev.preventDefault();
        window.addEventListener('keydown', this._kd); window.addEventListener('keyup', this._ku);
        this.dom.addEventListener('pointerdown', this._md); window.addEventListener('pointermove', this._mm); window.addEventListener('pointerup', this._mu);
        this.dom.addEventListener('wheel', this._wh, { passive: false }); this.dom.addEventListener('contextmenu', this._cm);
      } else {
        this.free = false;
        window.removeEventListener('keydown', this._kd); window.removeEventListener('keyup', this._ku);
        window.removeEventListener('blur', this._clr); document.removeEventListener('visibilitychange', this._clr); this.keys = {};
        this.dom.removeEventListener('pointerdown', this._md); window.removeEventListener('pointermove', this._mm); window.removeEventListener('pointerup', this._mu);
        this.dom.removeEventListener('wheel', this._wh); this.dom.removeEventListener('contextmenu', this._cm);
        const f = new THREE.Vector3(); this.camera.getWorldDirection(f);
        this.controls.target.copy(this.camera.position).addScaledVector(f, 8); this.controls.target.y = Math.max(0, this.controls.target.y);
        this.controls.enabled = true; this.controls.update();
      }
    }

    enterPov(which) {
      if (this.free) this.setFree(false);
      if (!this.pov) this.saved = { pos: this.camera.position.clone(), target: this.controls.target.clone(), fov: this.camera.fov };
      this.pov = which; this.tween = null;
      this.controls.enabled = false;
      document.body.classList.add('pov');
    }
    exitPov(silent) {
      if (!this.pov) return;
      this.pov = null; this.controls.enabled = true;
      document.body.classList.remove('pov');
      if (this.saved && !silent) { this.camera.position.copy(this.saved.pos); this.controls.target.copy(this.saved.target); this.camera.fov = this.saved.fov; this.camera.updateProjectionMatrix(); }
    }

    update(dt) {
      if (this.free) {
        const k = this.keys, sp = this.speed * (k.ShiftLeft || k.ShiftRight ? 3 : 1) * dt;
        this.camera.quaternion.setFromEuler(new THREE.Euler(this.fx, this.fy, 0, 'YXZ'));
        const f = new THREE.Vector3(); this.camera.getWorldDirection(f);
        const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
        const p = this.camera.position;
        if (k.KeyW || k.ArrowUp) p.addScaledVector(f, sp); if (k.KeyS || k.ArrowDown) p.addScaledVector(f, -sp);
        if (k.KeyD || k.ArrowRight) p.addScaledVector(r, sp); if (k.KeyA || k.ArrowLeft) p.addScaledVector(r, -sp);
        if (k.KeyE) p.y += sp; if (k.KeyQ) p.y -= sp;
        p.y = Math.max(0.3, p.y);
        return;
      }
      if (this.pov) {
        const cam = this.world.camPov(this.pov);
        this.camera.position.copy(cam.position); this.camera.quaternion.copy(cam.quaternion);
        if (this.camera.fov !== cam.fov) { this.camera.fov = cam.fov; this.camera.updateProjectionMatrix(); }
        return;
      }
      if (this.tween) {
        const tw = this.tween; tw.t += dt / tw.dur;
        const k = ease(Math.min(1, tw.t));
        this.camera.position.lerpVectors(tw.p0, tw.p1, k);
        this.controls.target.lerpVectors(tw.t0, tw.t1, k);
        this.camera.fov = tw.f0 + (tw.f1 - tw.f0) * k; this.camera.updateProjectionMatrix();
        if (tw.t >= 1) this.tween = null;
      }
      if (this.autoOrbit && !this.tween) {
        const off = this.camera.position.clone().sub(this.controls.target);
        const a = dt * 0.12, cs = Math.cos(a), sn = Math.sin(a);
        this.camera.position.set(this.controls.target.x + off.x * cs - off.z * sn, this.camera.position.y, this.controls.target.z + off.x * sn + off.z * cs);
      }
      // la camara no atraviesa la azotea
      if (this.camera.position.y < 0.35) this.camera.position.y = 0.35;
      this.controls.update();
    }
  }

  LAB.scene.CameraRig = CameraRig;
  LAB.scene.framing = { corners, fitDistance, ndc };
})();
