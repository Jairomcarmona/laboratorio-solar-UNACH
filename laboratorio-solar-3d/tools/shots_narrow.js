/* Capturas de la escena con paneles en ventanas pequenas: node tools/shots_narrow.js <carpeta> */
const h = require('./lib/harness.js'); const path = require('path'); const fs = require('fs');
(async () => {
  const out = process.argv[2] || 'shots'; fs.mkdirSync(out, { recursive: true });
  const b = await h.launch();
  for (const [W, H] of [[390, 844], [900, 520], [1024, 768]]) {
    const { page, ctx } = await h.open(b, 'session=student&time=2026-10-23T12:00&cloud=0.1', { width: W, height: H }, []);
    await page.evaluate(() => { document.getElementById('toasts').style.display = 'none'; const t = document.querySelector('#viewtabs [data-view=scene]'); if (t && document.body.dataset.layout !== 'wide') t.click(); });
    await page.waitForTimeout(5000); await page.screenshot({ path: path.join(out, `escena_${W}x${H}.png`) }); console.log('captura', W, H); await ctx.close();
  }
  await b.close();
})();
