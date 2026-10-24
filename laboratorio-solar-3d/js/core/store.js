/* Persistencia local versionada (C03). Dos niveles:
 *   - localStorage  : progreso pequeno por perfil (practicas, respuestas, evidencia). Clave 'labsolar.v2.<perfil>.progress'
 *   - IndexedDB     : corridas y barridos grandes (hasta 20 000 muestras por corrida)
 * Si el navegador bloquea o llena el almacenamiento, todo sigue funcionando en memoria y la interfaz lo muestra
 * (store.status). Nada de esto es una cuenta: el perfil se deriva del rol de demostracion y el nombre escrito.
 * Formato y migraciones: docs/FORMATO_PERSISTIDO.md */
(function () {
  'use strict';
  const LABNS = (window.LAB = window.LAB || {});
  LABNS.core = LABNS.core || {};
  const cfg = () => LABNS.config;
  const PREFIX = 'labsolar.v2.';
  const LEGACY_KEY = 'labsolar.practices';

  const mem = { ls: {}, runs: {}, sweeps: {} };
  const status = { mode: 'unknown', lastSavedAt: null, error: '', persistent: false, idb: false };
  const listeners = [];
  const notify = () => listeners.forEach((f) => { try { f(status); } catch (e) { /* oyente */ } });

  const ls = (() => { try { const t = '__t'; window.localStorage.setItem(t, '1'); window.localStorage.removeItem(t); return window.localStorage; } catch (e) { status.error = 'localStorage no disponible'; return null; } })();
  status.mode = ls ? 'local' : 'memoria'; status.persistent = !!ls;

  const profileId = (role, name) => {
    const s = `${role || 'visitor'}|${String(name || '').trim().toLowerCase()}`;
    let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return 'u' + (h >>> 0).toString(36);
  };

  const emptyProgress = (pid) => ({ schemaVersion: cfg().schemaVersion, appVersion: cfg().appVersion, kind: 'labsolar-progress', profileId: pid, updatedAtUtc: new Date().toISOString(), activePractice: null, practices: {} });

  /** Convierte cualquier Set a lista y descarta lo no serializable (los Set se perdian al guardar) */
  const plain = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v instanceof Set ? Array.from(v) : (typeof v === 'function' ? undefined : v))));

  function migrate(obj, pid) {
    if (!obj || typeof obj !== 'object') return emptyProgress(pid);
    if (obj.kind !== 'labsolar-progress') return emptyProgress(pid);
    if (!Number.isInteger(obj.schemaVersion) || obj.schemaVersion > cfg().schemaVersion) throw new Error(`Versión de datos ${obj.schemaVersion} no soportada por esta aplicación (${cfg().schemaVersion}).`);
    // v1 -> v2 (futuro): aqui se encadenarian las migraciones
    obj.schemaVersion = cfg().schemaVersion;
    obj.practices = obj.practices && typeof obj.practices === 'object' ? obj.practices : {};
    return obj;
  }

  function legacyCompleted() {
    if (!ls) return {};
    try { const o = JSON.parse(ls.getItem(LEGACY_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
  }

  const store = {
    status, PREFIX,
    onStatus(fn) { listeners.push(fn); },
    profileId,
    emptyProgress,
    plain,

    /** Carga el progreso del perfil; si esta corrupto lo conserva aparte y empieza limpio avisando */
    loadProgress(pid) {
      const key = PREFIX + pid + '.progress';
      let raw = null;
      try { raw = ls ? ls.getItem(key) : mem.ls[key] || null; } catch (e) { status.error = 'No se pudo leer el almacenamiento'; }
      let prog, warn = '';
      if (raw) {
        try { prog = migrate(JSON.parse(raw), pid); } catch (e) {
          warn = `Los datos guardados de este perfil no se pudieron leer (${e.message}). Se conservó una copia aparte y se empezó limpio.`;
          try { if (ls) ls.setItem(key + '.corrupt.' + Date.now(), raw); } catch (e2) { /* sin espacio */ }
          prog = emptyProgress(pid);
        }
      } else prog = emptyProgress(pid);
      // practicas completadas con el criterio anterior: se conservan, marcadas como tales
      const leg = legacyCompleted();
      for (const [id, ts] of Object.entries(leg)) {
        if (!prog.practices[id] && typeof ts === 'number') prog.practices[id] = { practiceId: id, status: 'completed_legacy', legacyCompletedAtUtc: new Date(ts).toISOString(), defVersion: 1, evidence: {}, answers: {}, steps: {} };
      }
      prog.warning = warn;
      return prog;
    },

    saveProgress(pid, prog) {
      prog.updatedAtUtc = new Date().toISOString(); prog.schemaVersion = cfg().schemaVersion; prog.appVersion = cfg().appVersion;
      const key = PREFIX + pid + '.progress';
      const copy = plain(prog); delete copy.warning;
      const txt = JSON.stringify(copy);
      mem.ls[key] = txt;
      if (!ls) { status.mode = 'memoria'; status.error = 'El navegador no permite guardar datos locales: el progreso se perderá al cerrar la pestaña.'; notify(); return false; }
      try { ls.setItem(key, txt); status.mode = 'local'; status.error = ''; status.lastSavedAt = Date.now(); notify(); return true; } catch (e) {
        status.mode = 'memoria';
        status.error = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message)) ? 'Almacenamiento lleno: el progreso solo está en memoria. Descarga una copia de seguridad.' : 'No se pudo guardar en el navegador. Descarga una copia de seguridad.';
        notify(); return false;
      }
    },

    clearProfile(pid) { const key = PREFIX + pid + '.progress'; delete mem.ls[key]; try { if (ls) ls.removeItem(key); } catch (e) { /* nada */ } },

    // ---------------------------------------------------------------- IndexedDB (corridas y barridos)
    _db: null,
    _open() {
      if (this._db) return this._db;
      this._db = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB no disponible'));
        const rq = indexedDB.open('labsolar-unach', 1);
        rq.onupgradeneeded = () => { const db = rq.result; db.createObjectStore('runs', { keyPath: 'id' }); db.createObjectStore('sweeps', { keyPath: 'id' }); };
        rq.onsuccess = () => { status.idb = true; resolve(rq.result); };
        rq.onerror = () => reject(rq.error || new Error('IndexedDB falló'));
        rq.onblocked = () => reject(new Error('IndexedDB bloqueada'));
      }).catch((e) => { status.idb = false; status.error = status.error || `Corridas solo en memoria (${e.message}).`; notify(); return null; });
      return this._db;
    },
    async _put(storeName, obj) {
      const rec = plain(obj);
      mem[storeName][rec.id] = rec;
      const db = await this._open(); if (!db) return false;
      return new Promise((resolve) => {
        try {
          const tx = db.transaction(storeName, 'readwrite'); tx.objectStore(storeName).put(rec);
          tx.oncomplete = () => { status.lastSavedAt = Date.now(); notify(); resolve(true); };
          tx.onerror = tx.onabort = () => { status.error = 'No se pudo guardar la corrida (¿almacenamiento lleno?). Exporta el CSV.'; notify(); resolve(false); };
        } catch (e) { resolve(false); }
      });
    },
    putRun(run) { return this._put('runs', run); },
    putSweep(sw) { return this._put('sweeps', sw); },
    async _list(storeName, pid) {
      const out = new Map(Object.values(mem[storeName]).map((r) => [r.id, r]));
      const db = await this._open();
      if (db) {
        await new Promise((resolve) => {
          try { const rq = db.transaction(storeName).objectStore(storeName).getAll(); rq.onsuccess = () => { rq.result.forEach((r) => out.set(r.id, r)); resolve(); }; rq.onerror = () => resolve(); } catch (e) { resolve(); }
        });
      }
      return Array.from(out.values()).filter((r) => !pid || r.profileId === pid).sort((a, b) => (a.createdAtUtc || '').localeCompare(b.createdAtUtc || ''));
    },
    listRuns(pid) { return this._list('runs', pid); },
    listSweeps(pid) { return this._list('sweeps', pid); },
    async deleteRun(id) {
      delete mem.runs[id]; const db = await this._open(); if (!db) return;
      await new Promise((resolve) => { try { const tx = db.transaction('runs', 'readwrite'); tx.objectStore('runs').delete(id); tx.oncomplete = tx.onerror = () => resolve(); } catch (e) { resolve(); } });
    },

    // ---------------------------------------------------------------- copia de seguridad
    async exportAll(pid, prog) {
      return { kind: 'labsolar-backup', schemaVersion: cfg().schemaVersion, appVersion: cfg().appVersion, exportedAtUtc: new Date().toISOString(), profileId: pid,
        note: 'Datos SIMULADOS de la demostración local; el perfil no es una cuenta autenticada.', progress: plain(prog), runs: await this.listRuns(pid), sweeps: await this.listSweeps(pid) };
    },

    /** Valida un JSON importado ANTES de usarlo. Devuelve {ok, errors[], data?} */
    validateBackup(obj) {
      const errors = [];
      const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
      if (!isObj(obj)) return { ok: false, errors: ['El archivo no contiene un objeto JSON.'] };
      if (obj.kind !== 'labsolar-backup') errors.push('No es una copia de seguridad del laboratorio (kind).');
      if (!Number.isInteger(obj.schemaVersion)) errors.push('Falta schemaVersion.');
      else if (obj.schemaVersion > cfg().schemaVersion) errors.push(`La copia es de una versión más nueva (${obj.schemaVersion}).`);
      if (!isObj(obj.progress) || obj.progress.kind !== 'labsolar-progress' || !isObj(obj.progress.practices)) errors.push('Progreso ausente o con formato inválido.');
      const okId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);
      if (obj.profileId != null && !okId(obj.profileId)) errors.push('profileId inválido.');
      if (isObj(obj.progress) && isObj(obj.progress.practices)) {
        for (const [pid, ps] of Object.entries(obj.progress.practices)) {
          if (!okId(pid) || !isObj(ps)) { errors.push(`Práctica ${String(pid).slice(0, 20)} con formato inválido.`); continue; }
          if (ps.answers && !isObj(ps.answers)) errors.push(`Respuestas de ${pid} inválidas.`);
          if (ps.steps && !isObj(ps.steps)) errors.push(`Pasos de ${pid} inválidos.`);
        }
      }
      for (const key of ['runs', 'sweeps']) {
        if (obj[key] != null && !Array.isArray(obj[key])) { errors.push(`${key} debe ser una lista.`); continue; }
        (obj[key] || []).forEach((r, i) => {
          if (!isObj(r) || !okId(r.id)) errors.push(`${key}[${i}] sin id válido.`);
          else if (key === 'runs' && (!Array.isArray(r.samples) || !Array.isArray(r.cols) || r.samples.some((row) => !Array.isArray(row) || row.length !== r.cols.length))) errors.push(`runs[${i}] con muestras inconsistentes.`);
        });
      }
      return errors.length ? { ok: false, errors: errors.slice(0, 8) } : { ok: true, errors: [], data: obj };
    },

    async importBackup(obj, pid) {
      const v = this.validateBackup(obj); if (!v.ok) return v;
      const prog = migrate(plain(obj.progress), pid); prog.profileId = pid;
      this.saveProgress(pid, prog);
      for (const r of obj.runs || []) { r.profileId = pid; r.imported = true; await this.putRun(r); }
      for (const s of obj.sweeps || []) { s.profileId = pid; s.imported = true; await this.putSweep(s); }
      return { ok: true, errors: [], progress: prog, runs: (obj.runs || []).length, sweeps: (obj.sweeps || []).length };
    },
  };

  LABNS.core.store = store;
})();
