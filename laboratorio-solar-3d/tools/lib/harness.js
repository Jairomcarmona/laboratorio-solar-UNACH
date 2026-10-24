/* Utilidades comunes de las pruebas: descubrimiento portable de Playwright y Chromium, aserciones con codigo de salida. */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

function findPlaywright() {
  const tries = [];
  if (process.env.PLAYWRIGHT_MODULE) tries.push(process.env.PLAYWRIGHT_MODULE);
  tries.push('playwright', '@playwright/test');
  try { tries.push(path.join(cp.execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright')); } catch (e) { /* sin npm */ }
  for (const t of tries) { try { return require(t); } catch (e) { /* siguiente */ } }
  throw new Error('No se encontró Playwright. Instala "playwright" o define PLAYWRIGHT_MODULE con su ruta.');
}
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers', path.join(process.env.HOME || '', '.cache/ms-playwright')].filter(Boolean);
  for (const r of roots) {
    try { for (const d of fs.readdirSync(r).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) { for (const sub of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) { const p = path.join(r, d, sub); if (fs.existsSync(p)) return p; } } } catch (e) { /* siguiente */ }
  }
  return undefined;   // que Playwright use el suyo
}
async function launch(extraArgs = []) {
  const { chromium } = findPlaywright();
  return chromium.launch({ executablePath: findChromium(), args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox', ...extraArgs] });
}
const ROOT = process.env.LAB_ROOT ? path.resolve(process.env.LAB_ROOT) : path.resolve(__dirname, '../..');   // LAB_ROOT: copia alternativa del proyecto (comparar distribuciones)
const url = (qs = '') => 'file://' + path.join(ROOT, 'index.html') + (qs ? '?' + qs : '');

class T {
  constructor(name) { this.name = name; this.results = []; this.fails = 0; }
  ok(id, cond, detail = '') { const r = { id, ok: !!cond, detail: String(detail) }; this.results.push(r); if (!cond) this.fails++; console.log(`${cond ? 'OK   ' : 'FALLA'} ${id}${detail ? ' — ' + detail : ''}`); return !!cond; }
  eq(id, a, b, detail = '') { return this.ok(id, a === b, `${detail} obtenido=${JSON.stringify(a)} esperado=${JSON.stringify(b)}`); }
  done() { console.log(`\n${this.name}: ${this.results.length - this.fails}/${this.results.length} correctas`); if (this.fails) process.exitCode = 1; return this.fails === 0; }
}
async function open(browser, qs, viewport = { width: 1536, height: 864 }, errors = []) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(url(qs));
  await page.waitForFunction('window.__labReady === true', null, { timeout: 90000 });
  return { page, ctx };
}
/** Avanza el motor a mano (swiftshader va a ~1 fps): n pasos de dt segundos */
const step = (page, n, dt = 0.1) => page.evaluate(([n, dt]) => { for (let i = 0; i < n; i++) LAB.app.source.step(dt); }, [n, dt]);
module.exports = { launch, open, step, T, url, ROOT, findChromium };
