// Arnés de pruebas aislado para NuHio: Chrome real con TODA la red interceptada.
// Nada sale a Internet: index.html se sirve desde disco, auth.js y las librerías
// de terceros son sustitutos locales y cualquier otra petición se aborta.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const require = createRequire(import.meta.url);
export const chromium = (() => {
  for (const p of ['playwright', '/opt/npm-tools/node_modules/playwright']) {
    try { return require(p).chromium; } catch {}
  }
  throw new Error('Playwright no disponible');
})();

const VEND = process.env.NUHIO_VENDOR_DIR; // three.min.js (0.128) real, fuera del repo
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
export const FAKE_JWT = `${b64({alg:'none'})}.${b64({sub:'usuario-de-prueba-local'})}.x`;

const authStub = `var SES={access_token:${JSON.stringify(FAKE_JWT)},refresh_token:'x',email:'prueba@local.invalid'};
async function sbTok(){return SES.access_token}
function accountPanel(){}`;
const orbitStub = `THREE.OrbitControls=class extends THREE.EventDispatcher{constructor(o,d){super();this.object=o;this.domElement=d;this.target=new THREE.Vector3();this.enabled=true;this.mouseButtons={};this.touches={}}update(){}dispose(){}saveState(){}reset(){}listenToKeyEvents(){}};`;
const objStub = `THREE.OBJLoader=class{load(){}parse(){return new THREE.Group()}setMaterials(){return this}};`;
const gltfStub = `THREE.GLTFLoader=class{load(){}parse(){}setDRACOLoader(){return this}setPath(){return this}};`;
const pdfStub = `window.pdfjsLib={GlobalWorkerOptions:{},getDocument(){throw new Error('pdf.js simulado')}};`;

export async function abrirEditor(browser, { baseDir = root } = {}) {
  if (!VEND) throw new Error('Defina NUHIO_VENDOR_DIR con three.min.js');
  const html = readFileSync(resolve(baseDir, 'disenador-web/index.html'), 'utf8');
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: false });
  const bloqueadas = [];
  const errores = [];
  const peticiones = [];
  await ctx.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.hostname !== 'nuhio.test') { bloqueadas.push(u.href); return route.abort(); }
    const p = u.pathname;
    peticiones.push(p);
    const js = body => route.fulfill({ status: 200, contentType: 'text/javascript', body });
    if (p === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (p === '/auth.js') return js(authStub);
    if (p.endsWith('three.min.js')) return js(readFileSync(resolve(VEND, 'three.min.js'), 'utf8'));
    if (p.endsWith('OrbitControls.js')) return js(orbitStub);
    if (p.endsWith('OBJLoader.js')) return js(objStub);
    if (p.endsWith('GLTFLoader.js')) return js(gltfStub);
    if (p.endsWith('pdf.min.js')) return js(pdfStub);
    return route.fulfill({ status: 404, body: '' });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errores.push(String(e)));
  page.on('dialog', d => { errores.push('dialog:' + d.message()); d.dismiss(); });
  await page.goto('https://nuhio.test/', { waitUntil: 'load' });
  return { ctx, page, bloqueadas, errores, peticiones };
}
