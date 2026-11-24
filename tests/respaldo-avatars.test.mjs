// Revisión estática de los scripts manuales de supabase/manual/avatars (no ejecuta nada contra Supabase).
// Su comportamiento se ejecuta de verdad en tests/sql-respaldo-pglite.test.mjs (PostgreSQL en memoria).
// Ejecutar: node --test tests/respaldo-avatars.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'supabase/manual/avatars');
const crudo = f => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n');
const sql = f => crudo(f).replace(/--.*$/gm, '');
const ESCRITURA = /\b(insert\s+into|update\s+\w|delete\s+from|truncate\s+\w|alter\s+(table|schema|policy|role)|drop\s+(table|schema|policy)|create\s+(table|schema|policy)|grant\s|revoke\s)/i;
const bloque = f => { const m = /-- <clasificacion>[^\n]*\n([\s\S]*?)-- <\/clasificacion>/.exec(crudo(f)); return m && m[1]; };

test('los scripts manuales existen y están fuera de supabase/migrations', () => {
  assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.sql')).sort(), [
    '01_inventario_solo_lectura.sql', '02_crear_respaldo.sql', '03_verificar_integridad.sql',
    '04_eliminar_respaldo.sql', '05_restaurar_desde_respaldo.sql',
  ]);
});

test('01 y 03 son de solo lectura y no devuelven el data URL', () => {
  for (const f of ['01_inventario_solo_lectura.sql', '03_verificar_integridad.sql']) {
    const s = sql(f);
    assert.doesNotMatch(s, ESCRITURA, f);
    assert.doesNotMatch(s, /\b(begin|commit)\b/i, f);
  }
  // 01: cada aparición del data URL está dentro de una función de tamaño, formato o huella.
  for (const linea of sql('01_inventario_solo_lectura.sql').split('\n').filter(l => /avatar_data(?!_)/.test(l)))
    assert.match(linea, /length\(|substring\(|split_part\(|\)\s*~|jsonb_typeof\(/, 'podría devolver el data URL: ' + linea.trim());
  assert.match(sql('03_verificar_integridad.sql'), /^select user_id, estado, avatar_data_actual, avatar_path, tipo_original, tipo_storage,/m, '03 no selecciona el data URL');
  assert.match(sql('01_inventario_solo_lectura.sql'), /where jsonb_typeof\(u\.raw_user_meta_data->'avatar_data'\) = 'string'/, 'null no es una foto');
});

test('03, 04 y 05 usan exactamente la misma clasificación de estados', () => {
  const b3 = bloque('03_verificar_integridad.sql');
  assert.ok(b3, 'existe el bloque');
  assert.equal(bloque('04_eliminar_respaldo.sql'), b3);
  assert.equal(bloque('05_restaurar_desde_respaldo.sql'), b3);
  for (const e of ['migrada_integra', 'fallo', 'pendiente', 'cambiada_por_usuario', 'eliminada_por_usuario', 'cuenta_eliminada', 'revisar'])
    assert.ok(b3.includes(`'${e}'`), e);
  assert.match(b3, /jsonb_typeof\(u\.raw_user_meta_data->'avatar_data'\) = 'null' then 'null'/, 'distingue null de ausente');
  assert.match(b3, /avatar-migrado\\\.\(jpg\|png\|webp\)\$/, 'JPEG, PNG y WebP');
  assert.match(b3, /o\.tipo is distinct from ob\.metadata->>'mimetype'/);
  assert.match(b3, /coalesce\(ob\.owner_id, ob\.owner::text\) is distinct from o\.user_id::text/);
});

test('02 solo lee auth.users, escribe únicamente en nuhio_respaldo, rechaza esquemas ajenos o expuestos y verifica permisos', () => {
  const s = sql('02_crear_respaldo.sql');
  for (const m of s.matchAll(new RegExp(ESCRITURA.source, 'gi'))) {
    const linea = s.slice(m.index, s.indexOf('\n', m.index));
    assert.match(linea, /nuhio_respaldo/, 'escritura fuera de nuhio_respaldo: ' + linea.trim());
  }
  assert.doesNotMatch(s, /update\s+auth\.|delete\s+from\s+auth\.|storage\.|(?<!nuhio_)\brespaldo\.[a-z_]/i, 'el antiguo esquema «respaldo» ya no se usa');
  assert.match(s, /raise exception 'Ya existe un esquema "nuhio_respaldo" que no es este respaldo/);
  assert.match(s, /raise exception 'El esquema "nuhio_respaldo" contiene otros objetos/);
  assert.match(s, /pgrst\.db_schemas/);
  assert.match(s, /raise exception 'anon o authenticated conservan permisos sobre el respaldo\.'/);
  assert.match(s, /^begin;[\s\S]*^commit;/m);
});

test('04 solo borra el respaldo y únicamente se niega por «fallo» o «revisar»', () => {
  const s = sql('04_eliminar_respaldo.sql');
  assert.match(s, /where estado in \('fallo', 'revisar'\)\) x;/);
  assert.deepEqual([...s.matchAll(/drop\s+(table|schema)\s+([\w.]+)/gi)].map(m => m[2]), ['nuhio_respaldo.avatar_data_20261121', 'nuhio_respaldo']);
  assert.doesNotMatch(s, /cascade|update\s+auth|delete\s+from/i);
});

test('05 solo añade avatar_data a «migrada_integra» o «fallo», sin tocar avatar_path ni Storage', () => {
  const s = sql('05_restaurar_desde_respaldo.sql');
  assert.match(s, /and e\.estado in \('migrada_integra', 'fallo'\);/);
  assert.match(s, /set raw_user_meta_data = coalesce\(u\.raw_user_meta_data, '\{\}'::jsonb\) \|\| jsonb_build_object\('avatar_data', o\.avatar_data\)/);
  assert.doesNotMatch(s, /-\s*'avatar_path'|delete|drop|insert|update\s+storage/i);
});
