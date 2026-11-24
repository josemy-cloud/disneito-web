// Migración ADMINISTRATIVA de fotos de perfil antiguas (user_metadata.avatar_data) al bucket privado `avatars`.
//
// Para qué: Storage de Supabase rechaza cabeceras de más de ~16 KB (431 o 400). Una cuenta cuya foto incrustada
// hace que su JWT supere ese tamaño no puede migrar desde el navegador. Este script lo hace con la clave
// service_role, desde el ordenador del administrador, SOLO para los UID y SHA-256 autorizados.
//
// Uso, en PowerShell (la clave se escribe oculta, solo vive en esa ventana y se borra al terminar):
//   $env:NUHIO_SUPABASE_SERVICE_ROLE_KEY = [Net.NetworkCredential]::new('', (Read-Host 'Clave service_role' -AsSecureString)).Password
//   node scripts/migrar-avatars-admin.mjs --uid <uuid>=<sha256>            simulación (no cambia nada)
//   node scripts/migrar-avatars-admin.mjs --uid <uuid>=<sha256> --ejecutar  migración real
//   Remove-Item Env:NUHIO_SUPABASE_SERVICE_ROLE_KEY
// Clave: variable de entorno temporal NUHIO_SUPABASE_SERVICE_ROLE_KEY. Nunca se imprime, guarda ni envía a otro host.
// La URL del proyecto se lee de disenador-web/auth.js (y la clave debe ser de ese proyecto).
//
// Garantías:
//  * Simulación por defecto; con --ejecutar solo actúa sobre los UID indicados, cada uno con su SHA-256 del
//    inventario 01. Si los bytes actuales de avatar_data no coinciden exactamente, se detiene sin tocar nada.
//  * Copia en avatars/<uid>/avatar-migrado.<ext> (la misma ruta que usa la aplicación). Si ya existe un objeto ahí:
//    con el mismo SHA-256 se reutiliza; con otro contenido se detiene (nunca lo sobrescribe). La subida usa
//    x-upsert: false, así que tampoco pisa un objeto creado a la vez por otro proceso.
//  * Antes de retirar avatar_data descarga la copia y comprueba tamaño y SHA-256.
//  * Justo antes de escribir, relee la cuenta: si el usuario ha cambiado su foto o sus metadatos, se detiene.
//  * Escribe avatar_path y avatar_data: null conservando el resto de user_metadata, y lo comprueba releyendo.
//  * Idempotente: repetirlo salta las cuentas ya migradas (las verifica) y reanuda las que se quedaron a medias.
//  * No registra claves, tokens, data URL ni bytes de las fotos: solo UID, tamaños, SHA-256 y estados.
//  * Recuperación: el respaldo nuhio_respaldo y 05_restaurar_desde_respaldo.sql siguen siendo válidos.
//
// Salida: 0 = todo correcto (o simulación lista), 1 = alguna cuenta detenida, 2 = uso o configuración incorrectos.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUCKET = 'avatars';
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/i;

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const igual = (a, b) => JSON.stringify(ordenar(a)) === JSON.stringify(ordenar(b));
function ordenar(v) { return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, ordenar(v[k])])) : v; }
const sinFoto = meta => { const m = { ...(meta || {}) }; delete m.avatar_data; delete m.avatar_path; return m; };
class Detener extends Error {}

export function leerProyecto(raiz = RAIZ) {
  const src = readFileSync(join(raiz, 'disenador-web', 'auth.js'), 'utf8');
  const url = /var SBU='(https:\/\/([a-z0-9]+)\.supabase\.co)'/.exec(src);
  if (!url) throw new Error('No se encontró la URL de Supabase en disenador-web/auth.js.');
  return { url: url[1], ref: url[2] };
}

// Comprueba que la clave es la service_role de ESTE proyecto (sin mostrarla). Las claves nuevas sb_secret_ no
// llevan el proyecto dentro: se aceptan y la primera llamada de administración confirma que valen aquí.
export function validarClave(clave, ref) {
  if (!clave) throw new Error('Falta la variable de entorno NUHIO_SUPABASE_SERVICE_ROLE_KEY.');
  if (/^sb_secret_/.test(clave)) return 'secret';
  const partes = clave.split('.');
  let carga = null;
  try { carga = JSON.parse(Buffer.from(partes[1] || '', 'base64url').toString('utf8')); } catch {}
  if (partes.length !== 3 || !carga) throw new Error('La clave no tiene formato de clave de Supabase.');
  if (carga.role !== 'service_role') throw new Error('La clave no es service_role (rol: ' + (carga.role || 'desconocido') + ').');
  if (carga.ref !== ref) throw new Error('La clave es de otro proyecto (' + carga.ref + '), no de ' + ref + '.');
  return 'service_role';
}

export function leerArgumentos(argv) {
  const objetivos = [], vistos = new Set();
  let ejecutar = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ejecutar') ejecutar = true;
    else if (a === '--uid') {
      const m = /^([^=]+)=(.+)$/.exec(argv[++i] || '');
      if (!m || !UUID.test(m[1]) || !SHA.test(m[2])) throw new Error('Formato: --uid <uuid>=<sha256 de 64 hexadecimales>');
      const uid = m[1].toLowerCase();
      if (vistos.has(uid)) throw new Error('UID repetido: ' + uid);
      vistos.add(uid); objetivos.push({ uid, sha256: m[2].toLowerCase() });
    } else throw new Error('Argumento no reconocido: ' + a);
  }
  if (!objetivos.length) throw new Error('Indica al menos un --uid <uuid>=<sha256>.');
  return { objetivos, ejecutar };
}

export async function migrarAvatarsAdmin({ url, clave, objetivos, ejecutar = false, log = console.log }) {
  const cab = extra => ({ apikey: clave, Authorization: 'Bearer ' + clave, ...extra });
  const ruta = p => p.split('/').map(encodeURIComponent).join('/');
  const leerUsuario = async uid => {
    const r = await fetch(url + '/auth/v1/admin/users/' + encodeURIComponent(uid), { headers: cab() });
    if (r.status === 404) throw new Detener('la cuenta no existe');
    if (!r.ok) throw new Detener('no se pudo leer la cuenta (HTTP ' + r.status + ')');
    return r.json();
  };
  const leerObjeto = async p => {
    const r = await fetch(url + '/storage/v1/object/authenticated/' + BUCKET + '/' + ruta(p), { headers: cab() });
    if (r.ok) return Buffer.from(await r.arrayBuffer());
    const cuerpo = await r.text().catch(() => '');
    if (r.status === 404 || /"statusCode"\s*:\s*"404"|not_found|Object not found/i.test(cuerpo)) return null;
    throw new Detener('no se pudo consultar Storage (HTTP ' + r.status + ')');
  };
  const resultados = [];
  for (const { uid, sha256: esperado } of objetivos) {
    const informe = (estado, detalle = '') => { resultados.push({ uid, estado, detalle }); log(`${uid}  ${estado}${detalle ? '  · ' + detalle : ''}`); };
    try {
      const u1 = await leerUsuario(uid), m1 = u1.user_metadata || {};
      if (u1.id !== uid) throw new Detener('la API devolvió otra cuenta');
      // ¿Ya migrada? (repetición del script o migración previa desde la aplicación)
      if (typeof m1.avatar_data !== 'string') {
        const p = m1.avatar_path;
        if (!p) throw new Detener('no tiene foto incrustada ni avatar_path: el usuario la eliminó o nunca la tuvo. No se hace nada');
        if (!new RegExp('^' + uid + '/avatar-migrado\\.(jpg|png|webp)$').test(p)) throw new Detener('el usuario ya tiene otra foto (' + p + '). No se hace nada');
        const b = await leerObjeto(p);
        if (!b) throw new Detener('avatar_path apunta a ' + p + ', pero el objeto no existe. Revisar con 03');
        if (sha256(b) !== esperado) throw new Detener('el objeto migrado no coincide con el SHA-256 autorizado. Revisar con 03');
        informe('ya-migrada', `${b.length} bytes, SHA-256 verificado, ${p}`);
        continue;
      }
      const m = DATA_URL.exec(m1.avatar_data);
      if (!m) throw new Detener('avatar_data no es un JPEG, PNG o WebP en base64 válido. No se toca');
      const tipo = m[1], bytes = Buffer.from(m[2], 'base64');
      if (bytes.toString('base64') !== m[2]) throw new Detener('el base64 de avatar_data no es canónico. No se toca');
      const huella = sha256(bytes);
      if (huella !== esperado) throw new Detener(`los bytes actuales (${bytes.length}, SHA-256 ${huella}) no coinciden con el SHA-256 autorizado. No se toca`);
      if (bytes.length > 524288) throw new Detener('la foto supera el límite del bucket (512 KB). No se toca');
      if (m1.avatar_path !== undefined && m1.avatar_path !== null) throw new Detener('tiene a la vez avatar_data y avatar_path (' + m1.avatar_path + '). Revisar a mano');
      const destino = `${uid}/avatar-migrado.${EXT[tipo]}`;
      const previo = await leerObjeto(destino);
      if (previo && sha256(previo) !== esperado) throw new Detener(`ya existe ${destino} con otro contenido (${previo.length} bytes). No se sobrescribe`);
      if (!ejecutar) {
        informe('simulacion-lista', `${bytes.length} bytes ${tipo}, SHA-256 coincide; ${previo ? 'reutilizaría la copia idéntica ya existente en ' : 'subiría a '}${destino} y retiraría avatar_data`);
        continue;
      }
      // 1. Copia en Storage (sin sobrescribir nunca).
      let subida = false;
      if (!previo) {
        const r = await fetch(url + '/storage/v1/object/' + BUCKET + '/' + ruta(destino), { method: 'POST', headers: cab({ 'Content-Type': tipo, 'x-upsert': 'false', 'Cache-Control': 'no-cache' }), body: bytes });
        if (r.ok) subida = true;
        else if (![400, 409].includes(r.status)) throw new Detener('Storage rechazó la subida (HTTP ' + r.status + '). avatar_data sigue intacto');
        else {
          // Posible creación simultánea: solo se acepta si el objeto que hay es idéntico.
          const otro = await leerObjeto(destino);
          if (!otro) throw new Detener('Storage rechazó la subida (HTTP ' + r.status + '). avatar_data sigue intacto');
          if (sha256(otro) !== esperado) throw new Detener(`ya existe ${destino} con otro contenido. No se sobrescribe; avatar_data sigue intacto`);
        }
      }
      // 2. Verificación por descarga.
      const copia = await leerObjeto(destino);
      if (!copia || copia.length !== bytes.length || sha256(copia) !== esperado) {
        // Solo se borra lo que ha subido esta ejecución y nadie referencia todavía.
        if (subida && copia) await fetch(url + '/storage/v1/object/' + BUCKET + '/' + ruta(destino), { method: 'DELETE', headers: cab() }).catch(() => {});
        throw new Detener('la copia en Storage no coincide con el original. avatar_data sigue intacto; vuelve a ejecutarlo');
      }
      // 3. ¿Ha cambiado algo durante el proceso?
      const u2 = await leerUsuario(uid), m2 = u2.user_metadata || {};
      if (m2.avatar_data !== m1.avatar_data || (m2.avatar_path ?? null) !== (m1.avatar_path ?? null) || !igual(sinFoto(m2), sinFoto(m1)))
        throw new Detener('el usuario ha cambiado su foto o sus datos durante el proceso. No se retira avatar_data; la copia verificada queda en ' + destino);
      // 4. Retirar avatar_data, conservando el resto de metadatos.
      let fallo = null;
      try {
        const r = await fetch(url + '/auth/v1/admin/users/' + encodeURIComponent(uid), { method: 'PUT', headers: cab({ 'Content-Type': 'application/json' }), body: JSON.stringify({ user_metadata: { ...m2, avatar_path: destino, avatar_data: null } }) });
        if (!r.ok) fallo = 'HTTP ' + r.status;
      } catch (e) { fallo = 'sin respuesta'; }
      // 5. Comprobación releyendo (también decide si una respuesta perdida llegó a aplicarse).
      const u3 = await leerUsuario(uid), m3 = u3.user_metadata || {};
      const aplicado = m3.avatar_path === destino && (m3.avatar_data === undefined || m3.avatar_data === null);
      if (!aplicado) {
        if (typeof m3.avatar_data === 'string' && m3.avatar_data === m1.avatar_data) throw new Detener(`no se aplicó el cambio de metadatos (${fallo || 'sin efecto'}). avatar_data sigue intacto; vuelve a ejecutarlo`);
        throw new Detener('estado inesperado tras actualizar los metadatos. Revisar con 03 (el respaldo sigue disponible)');
      }
      if (!igual(sinFoto(m3), sinFoto(m1))) throw new Detener('avatar_data se retiró, pero otros metadatos cambiaron. Revisar con 03');
      informe('migrada', `${bytes.length} bytes ${tipo}, SHA-256 verificado por descarga, ${destino}${fallo ? ' (la respuesta se perdió; comprobado releyendo)' : ''}`);
    } catch (e) {
      if (e instanceof Detener) informe('DETENIDA', e.message);
      else informe('DETENIDA', 'error inesperado: ' + (e && e.message ? e.message.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+|sb_secret_\w+/g, '[oculto]') : 'desconocido'));
    }
  }
  return resultados;
}

async function principal() {
  let objetivos, ejecutar, proyecto;
  const clave = process.env.NUHIO_SUPABASE_SERVICE_ROLE_KEY || '';
  try {
    ({ objetivos, ejecutar } = leerArgumentos(process.argv.slice(2)));
    proyecto = leerProyecto();
    validarClave(clave, proyecto.ref);
  } catch (e) { console.error('Error: ' + e.message); process.exitCode = 2; return; }
  console.log(`Proyecto ${proyecto.ref} · ${ejecutar ? 'MIGRACIÓN REAL' : 'SIMULACIÓN (no cambia nada; añade --ejecutar para migrar)'} · ${objetivos.length} cuenta(s)`);
  const res = await migrarAvatarsAdmin({ url: proyecto.url, clave, objetivos, ejecutar });
  const detenidas = res.filter(r => r.estado === 'DETENIDA').length;
  console.log(detenidas ? `${detenidas} cuenta(s) detenidas: revisa el motivo. No se ha retirado avatar_data de ninguna cuenta detenida antes del cambio de metadatos.` : 'Correcto.');
  process.exitCode = detenidas ? 1 : 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await principal();
