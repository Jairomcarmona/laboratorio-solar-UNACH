/* Conduce las practicas a traves de la interfaz real (botones de la guia y del banco) para pruebas de ciclo completo. */
const ANSWER = 'Respuesta de prueba suficientemente larga para registrarse: la razón entre potencias elimina el efecto ambiental común.';

async function adv(page, sec, dt = 0.1) {
  await page.evaluate(([sec, dt]) => { const s = LAB.app.source; for (let i = 0; i < Math.round(sec / dt); i++) { s.step(dt); LAB.ui.practices.tick(s.telemetry, dt); } window.__n = (window.__n || 0) + 1; LAB.ui.update(s.telemetry, 0, performance.now() + 1e5 * window.__n); }, [sec, dt]);
}
const click = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e || e.hidden || e.disabled) return false; e.click(); return true; }, sel);
const state = (page) => page.evaluate(() => { const s = LAB.ui.practices.state(); return s.ps ? { id: s.current, status: s.ps.status, steps: s.ps.steps, answers: s.ps.answers, E: s.E } : null; });

async function login(page, role = 'student', name = '') {
  if (name) await page.fill('#userName', name);
  await page.click(`#loginModal .role[data-role=${role}]`);
  await adv(page, 0.2);
}
async function openPractice(page, id) {
  await click(page, '#btnPractices');
  await page.waitForSelector('#practiceDrawer:not([hidden])');
  const ok = await page.evaluate((id) => { const i = LAB.ui.practices.list.findIndex((p) => p.id === id); const cards = document.querySelectorAll('#practiceDrawer .pcard'); const b = cards[i].querySelector('button'); b.click(); return b.textContent; }, id);
  await adv(page, 0.5);
  return ok;
}
/** Guarda la respuesta (o la prediccion) de una pregunta por la interfaz, si aun no esta guardada */
async function submitQuestion(page, q) {
  const done = await page.evaluate((q) => { const a = LAB.ui.practices.state().ps.answers[q]; return !!(a && a.submitted); }, q);
  if (done) return false;
  await page.fill('#ta_' + q, ANSWER);
  await page.evaluate((q) => { const ta = document.getElementById('ta_' + q); ta.parentElement.querySelector('.report button:not([hidden])').click(); }, q);
  await adv(page, 0.5);
  return true;
}
/** Escribe en las casillas de calculo del paso el valor de referencia de su propia corrida y pulsa Comprobar */
async function fillMeasure(page, sid, scale = 1) {
  await page.evaluate(([sid, scale]) => {
    const s = LAB.ui.practices.state(), def = LAB.ui.practices.list.find((p) => p.id === s.current), st = def.steps.find((x) => x.id === sid);
    st.measure.fields.forEach((f) => { const inp = document.getElementById(`m_${st.measure.id}_${f.k}`); inp.value = String(f.ref() * scale); inp.dispatchEvent(new Event('input', { bubbles: true })); });
    document.querySelector('#practiceGuide li.cur .measure button:not([hidden])').click();
  }, [sid, scale]);
  await adv(page, 0.5);
}
const send = (page, cmd) => page.evaluate((c) => LAB.app.source.send(c), cmd);
/** Un paso del conductor: devuelve false cuando no queda nada operativo por hacer */
async function turn(page) {
  const info = await page.evaluate(() => {
    const s = LAB.ui.practices.state(); if (!s.ps) return null;
    const def = LAB.ui.practices.list.find((p) => p.id === s.current);
    const cur = def.steps.find((x) => !x.optional && !s.ps.steps[x.id]);
    return { id: s.current, sid: cur ? cur.id : null, status: s.ps.status, q: cur && cur.question ? cur.question.id : null, predict: !!(cur && cur.question && cur.question.kind === 'predict'), measure: !!(cur && cur.measure) };
  });
  if (!info || !info.sid) return false;
  const clickAssist = () => page.evaluate(() => { const b = Array.from(document.querySelectorAll('#practiceGuide li.cur .stepbtns button')).find((x) => !x.hidden); if (b) { b.click(); return true; } return false; });
  if (info.predict) { await submitQuestion(page, info.q); return true; }
  if (info.measure) { await fillMeasure(page, info.sid); return true; }
  switch (info.sid) {
    case 'cond': case 'parts': for (let i = 0; i < 4; i++) { await clickAssist(); await adv(page, 0.5); } await adv(page, 1); break;
    case 'cam1': await clickAssist(); await adv(page, 1.5); await click(page, '#povExit'); await adv(page, 1); break;
    case 'oc': case 'sc': await clickAssist(); await adv(page, 4); break;
    case 'sweep': await clickAssist(); await adv(page, 11); break;
    case 'rep': for (let i = 0; i < 3; i++) { await clickAssist(); await adv(page, 11); } break;
    case 'mpp': await clickAssist(); await adv(page, 1); break;
    case 'nubes': await send(page, { type: 'sim.cloud', value: 0.7 }); await adv(page, 30); await clickAssist(); await adv(page, 11); break;
    case 'sun': await clickAssist(); await adv(page, 1); break;
    case 'az': for (const az of [120, 150, 210, 240]) { await send(page, { type: 'tracker.target', az, tilt: 17 }); await adv(page, 45); } break;
    case 'tilt': for (const tilt of [0, 40, 60, 80]) { await send(page, { type: 'tracker.target', az: 180, tilt }); await adv(page, 45); } break;
    case 'r-astro': case 'r-1eje': case 'r-sensor': case 'r-astro-nub': case 'r-sensor-nub': await clickAssist(); await adv(page, 75); break;
    case 'decide': await submitQuestion(page, 'p3q2'); break;
    default: await clickAssist(); await adv(page, 12);
  }
  return true;
}
async function doOperative(page, max = 80) {
  for (let i = 0; i < max; i++) { if (!(await turn(page))) return true; }
  return false;
}
async function answerAll(page) {
  const qs = await page.evaluate(() => LAB.ui.practices.list.find((p) => p.id === LAB.ui.practices.state().current).steps.filter((s) => s.question).map((s) => s.question.id));
  for (const q of qs) await submitQuestion(page, q);
}
module.exports = { adv, click, state, login, openPractice, turn, doOperative, answerAll, submitQuestion, fillMeasure, send, ANSWER };
