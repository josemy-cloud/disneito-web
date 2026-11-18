// Fidelidad de la simulación: el conjunto de assets que publica el arnés (tests/harness/real-harness.mjs) debe ser
// exactamente el que calcula Wrangler en `deploy --dry-run` (sin desplegar). Requiere WRANGLER_BIN; si no, se omite.
// Ejecutar: WRANGLER_BIN=<ruta a wrangler> node --test tests/assets-manifiesto-wrangler.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root, publishedAssets } from './harness/real-harness.mjs';

const WRANGLER = process.env.WRANGLER_BIN;

test('el manifiesto simulado coincide con el de wrangler deploy --dry-run', { skip: !WRANGLER && 'WRANGLER_BIN no definido' }, () => {
  const out = execFileSync(WRANGLER, ['deploy', '--dry-run', '--outdir', mkdtempSync(join(tmpdir(), 'nuhio-dry-'))], {
    cwd: root, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_LOG: 'debug', WRANGLER_SEND_METRICS: 'false' },
  });
  assert.match(out, /--dry-run: exiting now\./, 'no despliega');
  const lineas = out.split(/\r?\n/);
  const inicio = lineas.findIndex(l => /Read \d+ files from the assets directory/.test(l));
  assert.ok(inicio >= 0);
  const listados = [];
  for (const l of lineas.slice(inicio + 1)) { if (!l.startsWith('/')) break; listados.push(l.slice(1).replace(/\\/g, '/')); }
  const ignorados = new Set(lineas.filter(l => l.startsWith('Ignoring asset: ')).map(l => l.slice(16).trim().replace(/\\/g, '/')));
  const ficheros = listados.filter(p => statSync(join(root, 'disenador-web', p)).isFile());
  const wrangler = ficheros.filter(p => !ignorados.has(p)).sort();
  assert.ok(ignorados.has('inventario-modelos-3d.json') && ignorados.has('auditoria-biblioteca-modelos-3d.json'));
  assert.ok(wrangler.includes('materiales/FUENTES.md'));
  assert.deepEqual([...publishedAssets].sort(), wrangler);
});
