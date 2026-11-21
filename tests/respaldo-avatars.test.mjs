// Revisión estática de los scripts manuales de supabase/manual/avatars (no ejecuta nada contra Supabase):
// los de solo lectura no escriben y los que escriben se limitan a lo que declaran.
// Ejecutar: node --test tests/respaldo-avatars.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'supabase/manual/avatars');
const sql = f => readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').replace(/--.*$/gm, '');
const ESCRITURA = /\b(insert\s+into|update\s+\w|delete\s+from|truncate|alter\s+(table|schema|policy)|drop\s+(table|schema|policy|bucket)|create\s+(table|schema|policy)|grant\s|revoke\s)/i;

test('los scripts manuales existen y están fuera de supabase/migrations', () => {
  assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.sql')).sort(), [
    '01_inventario_solo_lectura.sql', '02_crear_respaldo.sql', '03_verificar_integridad.sql',
    '04_eliminar_respaldo.sql', '05_restaurar_desde_respaldo.sql',
  ]);
});

test('01 (inventario) y 03 (integridad) son de solo lectura y no exponen las imágenes', () => {
  for (const f of ['01_inventario_solo_lectura.sql', '03_verificar_integridad.sql']) {
    const s = sql(f);
    assert.doesNotMatch(s, ESCRITURA, f);
    assert.doesNotMatch(s, /\b(begin|commit)\b/i, f);
    // Cada aparición del data URL está dentro de length(), substring(), split_part(), un patrón (~) o «?».
    for (const linea of s.split('\n').filter(l => /avatar_data(?!_\d)/.test(l)))
      assert.match(linea, /length\(|substring\(|split_part\(|\)\s*~|\?\s*'avatar_data'/, f + ': podría devolver el data URL: ' + linea.trim());
  }
  assert.match(sql('01_inventario_solo_lectura.sql'), /md5\(decode\(split_part/);
  assert.match(sql('01_inventario_solo_lectura.sql'), /sha256\(decode\(split_part/);
  assert.match(sql('03_verificar_integridad.sql'), /left join storage\.objects ob on ob\.bucket_id = 'avatars'/);
});

test('02 (respaldo) solo lee auth.users, escribe únicamente en el esquema respaldo y verifica la copia', () => {
  const s = sql('02_crear_respaldo.sql');
  for (const m of s.matchAll(new RegExp(ESCRITURA.source, 'gi'))) {
    const linea = s.slice(m.index, s.indexOf('\n', m.index));
    assert.match(linea, /respaldo/, 'escritura fuera de respaldo: ' + linea.trim());
  }
  assert.doesNotMatch(s, /update\s+auth\.|delete\s+from\s+auth\.|storage\./i);
  assert.match(s, /revoke all on schema respaldo from public, anon, authenticated;/);
  assert.match(s, /revoke all on respaldo\.avatar_data_20261121 from public, anon, authenticated;/);
  assert.match(s, /enable row level security/);
  assert.match(s, /if n_origen <> n_copia or distintas <> 0 then\s+raise exception/);
  assert.match(s, /^begin;[\s\S]*^commit;/m);
});

test('04 (eliminar) solo borra el respaldo y se niega si falta alguna copia íntegra', () => {
  const s = sql('04_eliminar_respaldo.sql');
  assert.match(s, /if pendientes > 0 then\s+raise exception/);
  const borra = [...s.matchAll(/drop\s+(table|schema)\s+([\w.]+)/gi)].map(m => m[2]);
  assert.deepEqual(borra, ['respaldo.avatar_data_20261121', 'respaldo']);
  assert.doesNotMatch(s, /cascade|auth\.users\s+set|delete\s+from|storage\.objects\s+where[^;]*delete/i);
});

test('05 (restaurar) solo añade avatar_data desde el respaldo, sin borrar avatar_path ni Storage', () => {
  const s = sql('05_restaurar_desde_respaldo.sql');
  assert.match(s, /set raw_user_meta_data = coalesce\(u\.raw_user_meta_data, '\{\}'::jsonb\) \|\| jsonb_build_object\('avatar_data', r\.avatar_data\)/);
  assert.doesNotMatch(s, /-\s*'avatar_path'|delete|drop|storage\./i);
});
