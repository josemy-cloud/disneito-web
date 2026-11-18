// Regresión: los documentos internos no deben desplegarse como assets y nada necesario debe quedar excluido.
// Ejecutar: NUHIO_VENDOR_DIR=<dir con three.min.js> node --test tests/assets-internos.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, abrirEditor } from './harness/nuhio-harness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignoreFile = join(root, 'disenador-web/.assetsignore');
const INTERNOS = ['inventario-modelos-3d.json', 'auditoria-biblioteca-modelos-3d.json'];
const NECESARIOS = [
  'index.html', 'acceso.html', 'auth.js', 'adaptive.css', 'ui-redesign.css', 'scan-room.css',
  'scan-core.mjs', 'scan-room.mjs', 'scan-worker.mjs', 'scan-segformer-worker.mjs', 'nuhio-logo.webp',
  'icons/icon-192.png', 'icons/favicon-32.png', 'catalogo/productos-comerciales.json',
  'materiales/FUENTES.md', 'vendor/three@0.128.0/build/three.min.js', 'vendor/pdfjs-dist@3.11.174/build/pdf.min.js',
];
const ORIGINALES = ['**/*.map', '**/.env', '**/.env.*', '**/config.json', '**/*.pem', '**/*.key', '**/*.bat', '**/pruebas-local/**'];

// Evalúa .assetsignore con el motor de patrones de git (misma sintaxis gitignore que usa Cloudflare).
function ignorados(rutas) {
  const dir = mkdtempSync(join(tmpdir(), 'assetsignore-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  copyFileSync(ignoreFile, join(dir, '.gitignore'));
  const out = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: dir, input: rutas.join('\n'), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }
  ).split('\n').filter(Boolean);
  return new Set(out);
}
const seguro = rutas => { try { return ignorados(rutas); } catch (e) { if (e.status === 1) return new Set(); throw e; } };

test('los dos documentos internos quedan excluidos de los assets', () => {
  const x = seguro(INTERNOS);
  for (const f of INTERNOS) assert.ok(x.has(f), `${f} debe estar ignorado`);
});

test('la exclusión solo afecta a la raíz de assets (no a archivos homónimos de subcarpetas)', () => {
  assert.equal(seguro(['vendor/inventario-modelos-3d.json']).size, 0);
});

test('ningún archivo necesario para la aplicación queda excluido', () => {
  const x = seguro(NECESARIOS);
  assert.deepEqual([...x], []);
});

test('se conservan las reglas de seguridad originales', () => {
  const lineas = readFileSync(ignoreFile, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  for (const regla of ORIGINALES) assert.ok(lineas.includes(regla), `falta ${regla}`);
  assert.equal(lineas.length, ORIGINALES.length + INTERNOS.length, 'solo se añaden los dos documentos');
  const x = seguro(['a/b.map', '.env', 'x/.env.local', 'config.json', 'k.pem', 'k.key', 'run.bat', 'pruebas-local/x.html']);
  assert.equal(x.size, 8);
});

test('ningún código ni documento versionado referencia los documentos internos', () => {
  const tocados = [];
  // Solo archivos versionados: material local sin seguimiento (p. ej. parches o notas de auditoría) no cuenta.
  const versionados = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\0').filter(Boolean));
  const visita = d => { for (const n of readdirSync(d)) {
    if (['.git', 'node_modules', 'tests', 'vendor'].includes(n)) continue;
    const p = join(d, n), st = statSync(p);
    if (st.isDirectory()) { visita(p); continue; }
    if (!versionados.has(relative(root, p).split(sep).join('/'))) continue;
    if (INTERNOS.includes(n) || n === '.assetsignore' || st.size > 5_000_000) continue;
    if (!/\.(m?js|html|css|json|md|jsonc|toml|sql|txt)$/.test(n)) continue;
    const txt = readFileSync(p, 'utf8');
    if (INTERNOS.some(f => txt.includes(f))) tocados.push(relative(root, p));
  } };
  visita(root);
  assert.deepEqual(tocados, []);
});

test('el editor arranca y no solicita los documentos internos', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  try {
    const { page, peticiones, errores, ctx } = await abrirEditor(browser);
    await page.waitForTimeout(800);
    assert.deepEqual(errores, []);
    assert.ok(peticiones.includes('/'), 'carga el editor');
    for (const f of INTERNOS) assert.ok(!peticiones.some(p => p.endsWith(f)), `no debe pedir ${f}`);
    await ctx.close();
  } finally { await browser.close(); }
});
