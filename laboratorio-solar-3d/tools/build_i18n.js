/* Genera i18n/es.js e i18n/en.js (para <script>) a partir de i18n/es.json e i18n/en.json.  Uso: node tools/build_i18n.js [--check] */
const fs = require('fs'), path = require('path');
const dir = path.resolve(__dirname, '../i18n');
const check = process.argv.includes('--check');
let bad = 0;
for (const lang of ['es', 'en']) {
  const json = JSON.parse(fs.readFileSync(path.join(dir, lang + '.json'), 'utf8'));
  const body = `/* Generado por tools/build_i18n.js desde i18n/${lang}.json. No editar a mano. */\n(window.LAB = window.LAB || {}).i18n = window.LAB.i18n || { dict: {} };\nLAB.i18n.dict = LAB.i18n.dict || {}; LAB.i18n.dict.${lang} = Object.assign(LAB.i18n.dict.${lang} || {}, ${JSON.stringify(json)});\n`;
  const out = path.join(dir, lang + '.js');
  if (check) { if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== body) { console.error(`${lang}.js no corresponde a ${lang}.json: ejecuta node tools/build_i18n.js`); bad++; } }
  else fs.writeFileSync(out, body);
}
if (bad) process.exit(1);
