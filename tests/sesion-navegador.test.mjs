// Sesión y fotos de perfil en Chrome real con los archivos reales (acceso.html, auth.js, index.html, worker.js).
// Supabase Auth/Storage simulados con las reglas de la migración avatars_privados (ver tests/harness/real-harness.mjs).
// Ejecutar: node --test tests/sesion-navegador.test.mjs   (Chrome en CHROME_BIN)
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, abrirReal, entrarAlEditor, supa, crearUsuario, emitirSesion, reiniciarSupabase, estadoSupabase, USER } from './harness/real-harness.mjs';

const PREEXISTENTE = /Identifier 'authPasswordMinLength' has already been declared/;
const BYTES_FOTO = Buffer.alloc(11250, 7);                       // ≈15 KB en base64, como la foto real
const FOTO_INCRUSTADA = 'data:image/jpeg;base64,' + BYTES_FOTO.toString('base64');
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

let browser;
test.before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }); });
test.after(async () => { await browser?.close(); });
test.beforeEach(() => reiniciarSupabase());

const errores = s => s.errores.filter(e => !PREEXISTENTE.test(e) && !e.startsWith('dialog:'));
async function esperar(cond, ms = 10000, paso = 100) { const fin = Date.now() + ms; for (;;) { const v = await cond(); if (v) return v; if (Date.now() > fin) throw new Error('Tiempo agotado esperando: ' + cond); await new Promise(r => setTimeout(r, paso)); } }
const cookieSesion = async ctx => (await ctx.cookies('https://nuhio.test')).find(c => c.name === '__Host-disenito-session') || null;
const tokenActual = page => page.evaluate(() => SES && SES.access_token);
// Petición de solo lectura desde la página (con las cookies del navegador): 'opaqueredirect' = redirección de autenticación.
const estado = (page, ruta) => page.evaluate(async r => { const x = await fetch(r, { cache: 'no-store', redirect: 'manual' }); return x.type === 'opaqueredirect' ? 'redirect' : x.status; }, ruta);
const conFoto = (id = 'usuario-con-foto') => crearUsuario(id, { user_metadata: { full_name: 'Ana Prueba', avatar_data: FOTO_INCRUSTADA } });
const objetosDe = id => [...supa.objetos.keys()].filter(k => k.startsWith(id + '/'));
// Espera a que termine la migración automática que lanza la sincronización de la cookie al entrar.
const migracionTerminada = page => esperar(() => page.evaluate(async () => { await SESSION_SYNC; return !AVATAR_MIGRATION; }), 15000);

test('acceso con el formulario real: se crea la cookie (HttpOnly, Secure, Lax, ≤4000) con el token vigente y caduca con él', async () => {
  const s = await abrirReal(browser, { sesion: false });
  await s.page.goto('https://nuhio.test/acceso');
  await s.page.fill('input[name=email]', USER.email);
  await s.page.fill('input[name=password]', 'Prueba-Local-1');
  await s.page.click('button[type=submit]');
  await s.page.waitForFunction(() => typeof S === 'object' && document.getElementById('c2'), null, { timeout: 20000 });
  assert.equal(await s.page.evaluate(() => SESSION_SYNC), 'ok');
  const c = await cookieSesion(s.ctx);
  assert.ok(c, 'existe la cookie');
  assert.equal(c.value, await tokenActual(s.page));
  assert.equal(c.httpOnly, true); assert.equal(c.secure, true); assert.equal(c.sameSite, 'Lax'); assert.equal(c.path, '/');
  assert.ok(c.name.length + 1 + c.value.length <= 4000);
  const vida = c.expires - Date.now() / 1e3;
  assert.ok(vida > 3500 && vida <= 3600, 'caduca con el token (s): ' + vida);
  assert.equal(await s.page.evaluate(() => document.cookie.includes('disenito')), false, 'no accesible desde JavaScript');
  assert.deepEqual(errores(s), []);
  await s.ctx.close();
});

test('con sesión válida en el navegador: los dos JSON internos dan 404 real al navegar; las rutas legítimas, 200', async () => {
  const s = await abrirReal(browser);
  await entrarAlEditor(s.page);
  await esperar(() => cookieSesion(s.ctx));
  const nav = await s.ctx.newPage();
  for (const ruta of ['/inventario-modelos-3d.json', '/auditoria-biblioteca-modelos-3d.json']) {
    const r = await nav.goto('https://nuhio.test' + ruta);
    assert.equal(r.status(), 404, ruta);
    assert.equal(new URL(nav.url()).pathname, ruta, 'sin redirección: ' + nav.url());
    assert.equal(r.request().redirectedFrom(), null);
  }
  for (const ruta of ['/index.html', '/editor', '/catalogo/productos-comerciales.json', '/materiales/FUENTES.md', '/scan-room.mjs']) {
    assert.equal((await nav.goto('https://nuhio.test' + ruta)).status(), 200, ruta);
  }
  assert.equal(await estado(s.page, '/inventario-modelos-3d.json'), 404);
  await s.ctx.close();
});

test('renovación: al renovar el token se renueva la cookie; el temporizador lo hace antes de que caduque', async () => {
  const s = await abrirReal(browser, { sesion: emitirSesion(USER.id) });
  await entrarAlEditor(s.page);
  const t1 = await esperar(async () => (await cookieSesion(s.ctx))?.value);
  // Renovación bajo demanda (sbTok con el token a punto de caducar).
  await s.page.evaluate(async () => { SES.expires_at = Math.floor(Date.now() / 1e3) + 30; await sbTok(); await SESSION_SYNC; });
  const t2 = await tokenActual(s.page);
  assert.notEqual(t2, t1);
  assert.equal((await cookieSesion(s.ctx)).value, t2);
  // Renovación automática: el temporizador se programa ~50 s antes del vencimiento (mínimo 5 s).
  await s.page.evaluate(() => { SES.expires_at = Math.floor(Date.now() / 1e3) + 52; scheduleSessionRefresh(); });
  await esperar(async () => (await tokenActual(s.page)) !== t2, 12000);
  const t3 = await tokenActual(s.page);
  await esperar(async () => (await cookieSesion(s.ctx))?.value === t3, 5000);
  assert.equal(await estado(s.page, '/auditoria-biblioteca-modelos-3d.json'), 404, 'la cookie renovada sigue autenticando');
  assert.deepEqual(errores(s), []);
  await s.ctx.close();
});

test('caducidad y revocación: una cookie cuyo token ya no es válido vuelve a la redirección de autenticación', async () => {
  const ses = emitirSesion(USER.id);
  const s = await abrirReal(browser, { sesion: ses });
  await entrarAlEditor(s.page);
  await esperar(() => cookieSesion(s.ctx));
  assert.equal(await estado(s.page, '/index.html'), 200);
  supa.tokens.get(ses.access_token).revocado = true;           // p. ej., sesión cerrada en otro dispositivo
  assert.equal(await estado(s.page, '/index.html'), 'redirect');
  assert.equal(await estado(s.page, '/inventario-modelos-3d.json'), 'redirect');
  await s.ctx.close();
});

test('cierre de sesión: borra la cookie, revoca el token y vuelve a /acceso', async () => {
  const ses = emitirSesion(USER.id);
  const s = await abrirReal(browser, { sesion: ses });
  await entrarAlEditor(s.page);
  await esperar(() => cookieSesion(s.ctx));
  await Promise.all([s.page.waitForURL('**/acceso'), s.page.evaluate(() => leaveEditor())]);
  assert.equal(await cookieSesion(s.ctx), null);
  assert.equal(supa.tokens.get(ses.access_token).revocado, true);
  assert.equal(await s.page.evaluate(() => localStorage.getItem('sbSes')), null);
  assert.equal(await estado(s.page, '/index.html'), 'redirect');
  await s.ctx.close();
});

test('recuperación de sesión: tras cerrar el navegador (cookie de sesión perdida) se recupera desde localStorage y se recrea la cookie', async () => {
  const s = await abrirReal(browser, { sesion: emitirSesion(USER.id) });
  await entrarAlEditor(s.page);
  await esperar(() => cookieSesion(s.ctx));
  await s.ctx.clearCookies();                                  // equivale a reiniciar Chrome
  // Escribir /editor a mano: 302 → /acceso (Playwright no intercepta el destino de un 302 simulado,
  // así que se comprueba la redirección y se navega a su destino como haría Chrome).
  assert.equal(await estado(s.page, '/editor'), 'redirect');
  assert.equal(await estado(s.page, '/inventario-modelos-3d.json'), 'redirect');
  await s.page.goto('https://nuhio.test/acceso');
  await s.page.waitForFunction(() => typeof S === 'object' && document.getElementById('c2'), null, { timeout: 20000 });
  assert.equal(new URL(s.page.url()).pathname, '/editor', 'acceso restaura el editor (history.replaceState)');
  const c = await esperar(() => cookieSesion(s.ctx));
  assert.equal(c.value, await tokenActual(s.page));
  assert.equal(await estado(s.page, '/inventario-modelos-3d.json'), 404);
  assert.deepEqual(errores(s), []);
  await s.ctx.close();
});

test('migración de la foto incrustada: se sube, se verifica, se retira del JWT y la cookie queda establecida', async () => {
  conFoto();
  const ses = emitirSesion('usuario-con-foto');
  assert.ok(ses.access_token.length > 20000);
  const s = await abrirReal(browser, { sesion: ses });
  await entrarAlEditor(s.page);
  const c = await esperar(() => cookieSesion(s.ctx), 15000);
  const u = supa.usuarios.get('usuario-con-foto');
  assert.equal(u.user_metadata.avatar_path, 'usuario-con-foto/avatar-migrado.jpg');
  assert.equal('avatar_data' in u.user_metadata, false);
  assert.equal(u.user_metadata.full_name, 'Ana Prueba', 'no se pierden otros metadatos');
  assert.ok(supa.objetos.get('usuario-con-foto/avatar-migrado.jpg').bytes.equals(BYTES_FOTO), 'copia idéntica');
  const t = await tokenActual(s.page);
  assert.ok(t.length < 1500, 'JWT pequeño: ' + t.length);
  assert.equal(c.value, t);
  assert.ok(!estadoSupabase.reqs.some(r => r.includes('/object/public/') || r.includes('/object/sign/')), 'sin URLs públicas ni firmadas');
  assert.equal(await estado(s.page, '/inventario-modelos-3d.json'), 404);
  assert.equal(await estado(s.page, '/index.html'), 200);
  // El perfil muestra la foto privada como blob: local con los mismos bytes.
  await s.page.evaluate(() => accountPanel());
  const src = await esperar(() => s.page.evaluate(() => document.querySelector('#accountBox img[alt="Foto de perfil"]')?.src));
  assert.match(src, /^blob:https:\/\/nuhio\.test\//);
  const bytes = await s.page.evaluate(async u => [...new Uint8Array(await (await fetch(u)).arrayBuffer())].length, src);
  assert.equal(bytes, BYTES_FOTO.length);
  assert.deepEqual(errores(s), []);
  await s.ctx.close();
});

test('migración con fallos de Storage: conserva la foto original, no deja copias y la reintenta con éxito', async () => {
  conFoto();
  supa.fallos.subida = 3;                                      // agota los 3 intentos
  const s = await abrirReal(browser, { sesion: emitirSesion('usuario-con-foto') });
  await entrarAlEditor(s.page);
  await migracionTerminada(s.page);
  assert.equal(supa.fallos.subida, 0, 'se hicieron los 3 intentos');
  assert.equal(estadoSupabase.reqs.filter(r => r.startsWith('POST /storage/v1/object/avatars/usuario-con-foto/')).length, 3);
  const u = supa.usuarios.get('usuario-con-foto');
  assert.equal(u.user_metadata.avatar_data, FOTO_INCRUSTADA, 'la foto original sigue intacta');
  assert.equal('avatar_path' in u.user_metadata, false);
  assert.deepEqual(objetosDe('usuario-con-foto'), []);
  assert.equal(await cookieSesion(s.ctx), null, 'sin cookie mientras el token no quepa');
  assert.equal(await s.page.evaluate(() => typeof S === 'object' && Array.isArray(S.w)), true, 'el editor sigue funcionando');
  assert.equal(await s.page.evaluate(() => migrateAvatar()), 'migrada');
  assert.equal('avatar_data' in u.user_metadata, false);
  assert.ok(await esperar(() => cookieSesion(s.ctx)));
  await s.ctx.close();
});

test('migración con una copia corrupta: la detecta por hash, reintenta y, si persiste, conserva la original sin referenciar la copia', async () => {
  conFoto('foto-corrupta-1');
  supa.fallos.corromper = 1;                                   // falla el primer intento, el segundo es correcto
  const a = await abrirReal(browser, { sesion: emitirSesion('foto-corrupta-1') });
  await entrarAlEditor(a.page);
  await esperar(() => cookieSesion(a.ctx), 15000);
  assert.ok(supa.objetos.get('foto-corrupta-1/avatar-migrado.jpg').bytes.equals(BYTES_FOTO));
  await a.ctx.close();

  conFoto('foto-corrupta-2');
  supa.fallos.corromper = 3;
  const b = await abrirReal(browser, { sesion: emitirSesion('foto-corrupta-2') });
  await entrarAlEditor(b.page);
  await migracionTerminada(b.page);
  assert.equal(supa.fallos.corromper, 0, 'las 3 copias salieron corruptas');
  const m = supa.usuarios.get('foto-corrupta-2').user_metadata;
  assert.equal(m.avatar_data, FOTO_INCRUSTADA);
  assert.equal('avatar_path' in m, false, 'la copia defectuosa no se referencia');
  // La ruta compartida de migración nunca se borra: otro dispositivo podría haberla verificado y referenciado ya.
  assert.ok(!estadoSupabase.reqs.some(r => r.startsWith('DELETE ') && r.includes('avatar-migrado')));
  supa.fallos.corromper = 0;
  assert.equal(await b.page.evaluate(() => migrateAvatar()), 'migrada', 'el reintento sobrescribe la copia');
  assert.ok(supa.objetos.get('foto-corrupta-2/avatar-migrado.jpg').bytes.equals(BYTES_FOTO));
  await b.ctx.close();
});

test('carrera entre dos dispositivos: si uno falla al verificar, no borra la copia que el otro ya ha referenciado', async () => {
  conFoto();
  const u = supa.usuarios.get('usuario-con-foto');
  // Dispositivo 1 ya subió y verificó la copia y está a punto de apuntar avatar_path a ella.
  supa.objetos.set('usuario-con-foto/avatar-migrado.jpg', { bytes: BYTES_FOTO, tipo: 'image/jpeg', dueño: u.id });
  // Dispositivo 2 migra a la vez y se queda sin conexión en sus 3 intentos de subida.
  supa.fallos.red = 3;
  const s = await abrirReal(browser, { sesion: emitirSesion('usuario-con-foto') });
  await entrarAlEditor(s.page);
  await migracionTerminada(s.page);
  assert.equal(supa.fallos.red, 0, 'el dispositivo 2 agotó sus intentos');
  assert.ok(!estadoSupabase.reqs.some(r => r.startsWith('DELETE ') && r.includes('avatar-migrado')), 'no borra la ruta compartida');
  // El dispositivo 1 completa su cambio de metadatos: la foto referenciada existe e íntegra.
  u.user_metadata = { full_name: 'Ana Prueba', avatar_path: 'usuario-con-foto/avatar-migrado.jpg' };
  assert.ok(supa.objetos.get('usuario-con-foto/avatar-migrado.jpg').bytes.equals(BYTES_FOTO));
  await s.ctx.close();
});

test('corte de conexión durante la subida: se reintenta y la migración termina', async () => {
  conFoto();
  supa.fallos.red = 2;
  const s = await abrirReal(browser, { sesion: emitirSesion('usuario-con-foto') });
  await entrarAlEditor(s.page);
  await esperar(() => cookieSesion(s.ctx), 15000);
  assert.equal(supa.fallos.red, 0);
  assert.equal('avatar_data' in supa.usuarios.get('usuario-con-foto').user_metadata, false);
  assert.ok(supa.objetos.get('usuario-con-foto/avatar-migrado.jpg').bytes.equals(BYTES_FOTO));
  await s.ctx.close();
});

test('respuesta perdida tras aplicar los metadatos: estado coherente sin pérdida y el siguiente intento solo renueva el token', async () => {
  conFoto();
  supa.fallos.respuestaPerdida = 1;
  const s = await abrirReal(browser, { sesion: emitirSesion('usuario-con-foto') });
  await entrarAlEditor(s.page);
  await migracionTerminada(s.page);
  const m = supa.usuarios.get('usuario-con-foto').user_metadata;
  assert.equal('avatar_data' in m, false, 'Supabase aplicó el cambio');
  assert.equal(m.avatar_path, 'usuario-con-foto/avatar-migrado.jpg');
  assert.ok(supa.objetos.get(m.avatar_path).bytes.equals(BYTES_FOTO), 'la foto referenciada existe e íntegra');
  assert.equal(await cookieSesion(s.ctx), null, 'el cliente no lo sabe todavía');
  const subidasAntes = estadoSupabase.reqs.filter(r => r.startsWith('POST /storage/')).length;
  assert.equal(await s.page.evaluate(() => migrateAvatar()), 'sin-foto-incrustada');
  assert.equal(estadoSupabase.reqs.filter(r => r.startsWith('POST /storage/')).length, subidasAntes, 'no vuelve a subir');
  assert.ok(await esperar(() => cookieSesion(s.ctx)));
  await s.ctx.close();
});

test('varias pestañas: la que se quedó atrás adopta la sesión renovada en lugar de reutilizar un refresh token rotado', async () => {
  supa.intervaloReutilizacion = 0;                             // pestaña en segundo plano que despierta tarde
  const s = await abrirReal(browser, { sesion: emitirSesion(USER.id) });
  await entrarAlEditor(s.page);
  const b = await s.ctx.newPage();
  await entrarAlEditor(b);
  const viejaB = await b.evaluate(() => { window.__sinRecargar = true; return JSON.stringify(SES); });
  await s.page.evaluate(async () => { SES.expires_at = Math.floor(Date.now() / 1e3) + 30; await sbTok(); await SESSION_SYNC; });
  const nueva = await tokenActual(s.page);
  await esperar(async () => (await tokenActual(b)) === nueva, 3000);   // evento storage
  await new Promise(r => setTimeout(r, 500));
  assert.equal(await b.evaluate(() => window.__sinRecargar), true, 'renovar en otra pestaña no recarga esta (antes se veía un cierre de sesión momentáneo)');
  // Aunque B no hubiera recibido el evento (copia antigua en memoria), sbTok adopta la guardada sin renovar.
  await b.evaluate(v => { SES = JSON.parse(v); SES.expires_at = Math.floor(Date.now() / 1e3) + 30; }, viejaB);
  assert.equal(await b.evaluate(() => sbTok()), nueva);
  assert.equal(supa.reutilizaciones, 0, 'ningún refresh token reutilizado: la sesión no se revoca');
  assert.equal(await estado(b, '/inventario-modelos-3d.json'), 404);
  assert.equal(await estado(s.page, '/index.html'), 200);
  await s.ctx.close();
});

test('varias pestañas: dos renovaciones simultáneas hacen una sola petición de renovación', async () => {
  supa.intervaloReutilizacion = 0;
  const s = await abrirReal(browser, { sesion: emitirSesion(USER.id) });
  await entrarAlEditor(s.page);
  const b = await s.ctx.newPage();
  await entrarAlEditor(b);
  const n0 = estadoSupabase.reqs.filter(r => r.includes('grant_type=refresh_token')).length;
  await Promise.all([s.page, b].map(p => p.evaluate(() => { SES.expires_at = Math.floor(Date.now() / 1e3) + 30; })));
  const [ta, tb] = await Promise.all([s.page, b].map(p => p.evaluate(() => sbTok())));
  assert.equal(ta, tb);
  assert.equal(estadoSupabase.reqs.filter(r => r.includes('grant_type=refresh_token')).length - n0, 1);
  assert.equal(supa.reutilizaciones, 0);
  await s.ctx.close();
});

test('varias pestañas: cerrar sesión en una termina la sesión de las demás', async () => {
  const s = await abrirReal(browser, { sesion: emitirSesion(USER.id) });
  await entrarAlEditor(s.page);
  const b = await s.ctx.newPage();
  await entrarAlEditor(b);
  await Promise.all([s.page.waitForURL('**/acceso'), s.page.evaluate(() => leaveEditor())]);
  // El editor de la otra pestaña recarga al ver la sesión borrada: /editor → 302 → /acceso (formulario).
  await b.waitForURL('**/acceso', { timeout: 8000 });
  await b.waitForSelector('input[name=password]');
  assert.equal(await b.evaluate(() => SES), null);
  assert.equal(await cookieSesion(s.ctx), null);
  assert.equal(await estado(b, '/index.html'), 'redirect');
  await s.ctx.close();
});

test('reversión del código: con el auth.js anterior, las cuentas ya migradas y las no migradas siguen entrando', async () => {
  const { execFileSync } = await import('node:child_process');
  const anterior = execFileSync('git', ['show', 'desarrollo-cloudflare:disenador-web/auth.js'], { encoding: 'utf8' });
  assert.ok(!anterior.includes('syncSessionCookie'), 'es la versión anterior');
  crearUsuario('migrado', { user_metadata: { full_name: 'Migrado', avatar_path: 'migrado/avatar-migrado.jpg' } });
  supa.objetos.set('migrado/avatar-migrado.jpg', { bytes: BYTES_FOTO, tipo: 'image/jpeg', dueño: 'migrado' });
  conFoto('sin-migrar');
  for (const id of ['migrado', 'sin-migrar']) {
    const s = await abrirReal(browser, { sesion: emitirSesion(id), sustituir: { '/auth.js': anterior } });
    await entrarAlEditor(s.page);
    assert.equal(await s.page.evaluate(() => typeof syncSessionCookie), 'undefined', 'se usa el código anterior');
    await s.page.evaluate(() => accountPanel());
    await s.page.waitForSelector('#accountBox .studio-profile');
    const tieneFoto = await s.page.evaluate(() => !!document.querySelector('#accountBox img[alt="Foto de perfil"]'));
    assert.equal(tieneFoto, id === 'sin-migrar', 'migrado: iniciales; sin migrar: su foto como antes');
    assert.deepEqual(errores(s), [], id);
    await s.ctx.close();
  }
  assert.ok(supa.objetos.has('migrado/avatar-migrado.jpg'), 'la foto migrada se conserva');
});

test('SQL revertido con el código nuevo desplegado: nadie queda bloqueado y no se pierde ninguna foto', async () => {
  crearUsuario('migrado', { user_metadata: { full_name: 'Migrado', avatar_path: 'migrado/avatar-migrado.jpg' } });
  supa.objetos.set('migrado/avatar-migrado.jpg', { bytes: BYTES_FOTO, tipo: 'image/jpeg', dueño: 'migrado' });
  conFoto('sin-migrar');
  supa.storageBloqueado = true;
  const a = await abrirReal(browser, { sesion: emitirSesion('migrado') });
  await entrarAlEditor(a.page);
  assert.ok(await esperar(() => cookieSesion(a.ctx)), 'token pequeño: cookie normal');
  await a.page.evaluate(() => accountPanel());
  await a.page.waitForSelector('#accountBox .studio-profile');
  assert.equal(await a.page.evaluate(() => !!document.querySelector('#accountBox img[alt="Foto de perfil"]')), false, 'iniciales');
  assert.deepEqual(errores(a), []);
  await a.ctx.close();
  const b = await abrirReal(browser, { sesion: emitirSesion('sin-migrar') });
  await entrarAlEditor(b.page);
  await migracionTerminada(b.page);
  assert.equal(supa.usuarios.get('sin-migrar').user_metadata.avatar_data, FOTO_INCRUSTADA, 'foto original intacta');
  assert.equal(await b.page.evaluate(() => typeof S === 'object'), true, 'el editor funciona (Bearer)');
  assert.ok(supa.objetos.has('migrado/avatar-migrado.jpg'));
  await b.ctx.close();
});

test('migración con fallo al actualizar los metadatos: la original se conserva y el reintento reutiliza la misma copia', async () => {
  conFoto();
  supa.fallos.metadatos = 1;
  const s = await abrirReal(browser, { sesion: emitirSesion('usuario-con-foto') });
  await entrarAlEditor(s.page);
  await migracionTerminada(s.page);
  assert.equal(supa.fallos.metadatos, 0, 'falló la actualización de metadatos');
  assert.equal(supa.usuarios.get('usuario-con-foto').user_metadata.avatar_data, FOTO_INCRUSTADA);
  assert.deepEqual(objetosDe('usuario-con-foto'), ['usuario-con-foto/avatar-migrado.jpg'], 'copia verificada a la espera');
  assert.equal(await cookieSesion(s.ctx), null);
  assert.equal(await s.page.evaluate(() => migrateAvatar()), 'migrada');
  assert.deepEqual(objetosDe('usuario-con-foto'), ['usuario-con-foto/avatar-migrado.jpg'], 'una sola copia');
  assert.equal('avatar_data' in supa.usuarios.get('usuario-con-foto').user_metadata, false);
  await s.ctx.close();
});

test('sesión antigua: un token emitido antes de migrar (en otro dispositivo) solo se renueva, sin volver a subir nada', async () => {
  conFoto();
  const antigua = emitirSesion('usuario-con-foto');            // JWT grande, anterior a la migración
  const u = supa.usuarios.get('usuario-con-foto');
  supa.objetos.set('usuario-con-foto/avatar-migrado.jpg', { bytes: BYTES_FOTO, tipo: 'image/jpeg', dueño: u.id });
  u.user_metadata = { full_name: 'Ana Prueba', avatar_path: 'usuario-con-foto/avatar-migrado.jpg' };
  const s = await abrirReal(browser, { sesion: antigua });
  await entrarAlEditor(s.page);
  const c = await esperar(() => cookieSesion(s.ctx), 15000);
  assert.ok(c.value.length < 1500);
  assert.ok(!estadoSupabase.reqs.some(r => r.startsWith('POST /storage/')), 'no se sube nada');
  await s.ctx.close();
});

test('foto incrustada en un formato no admitido: no se toca (sin pérdida) y el editor funciona; la cookie queda pendiente', async () => {
  const gif = 'data:image/gif;base64,' + BYTES_FOTO.toString('base64');
  crearUsuario('foto-gif', { user_metadata: { avatar_data: gif } });
  const s = await abrirReal(browser, { sesion: emitirSesion('foto-gif') });
  await entrarAlEditor(s.page);
  await migracionTerminada(s.page);
  assert.ok(!estadoSupabase.reqs.some(r => r.startsWith('POST /storage/')), 'no se sube nada');
  assert.equal(await s.page.evaluate(() => migrateAvatar()), 'formato-no-admitido');
  assert.equal(supa.usuarios.get('foto-gif').user_metadata.avatar_data, gif);
  assert.equal(await cookieSesion(s.ctx), null);
  assert.equal(await s.page.evaluate(() => typeof S === 'object'), true);
  await s.ctx.close();
});

test('aislamiento entre usuarios (reglas RLS del bucket privado): nadie lee ni escribe fotos ajenas; sin URL pública', async () => {
  conFoto('victima');
  supa.objetos.set('victima/avatar-migrado.jpg', { bytes: BYTES_FOTO, tipo: 'image/jpeg', dueño: 'victima' });
  const s = await abrirReal(browser, { sesion: emitirSesion(USER.id) });
  await entrarAlEditor(s.page);
  const r = await s.page.evaluate(async () => {
    const tok = await sbTok(), base = SBU + '/storage/v1/object/';
    const h = { apikey: SBK, Authorization: 'Bearer ' + tok };
    const st = async (u, o = {}) => { const x = await fetch(u, o); return x.status + ':' + (await x.text()).slice(0, 60); };
    return {
      leerAjena: await st(base + 'authenticated/avatars/victima/avatar-migrado.jpg', { headers: h }),
      escribirAjena: await st(base + 'avatars/victima/x.jpg', { method: 'POST', headers: { ...h, 'Content-Type': 'image/jpeg', 'x-upsert': 'true' }, body: new Blob([new Uint8Array([1])]) }),
      borrarAjena: await st(base + 'avatars/victima/avatar-migrado.jpg', { method: 'DELETE', headers: h }),
      anonima: await st(base + 'authenticated/avatars/victima/avatar-migrado.jpg', { headers: { apikey: SBK } }),
      publica: await st(base + 'public/avatars/victima/avatar-migrado.jpg'),
    };
  });
  for (const [k, v] of Object.entries(r)) assert.ok(!v.startsWith('200'), k + ' → ' + v);
  assert.ok(supa.objetos.has('victima/avatar-migrado.jpg') && !supa.objetos.has('victima/x.jpg'));
  await s.ctx.close();
});

test('perfil: subir foto nueva (Storage, JWT pequeño), sustituirla (borra la anterior) y eliminarla', async () => {
  const s = await abrirReal(browser, { sesion: emitirSesion(USER.id) });
  await entrarAlEditor(s.page);
  const subir = async () => {
    await s.page.evaluate(() => accountPanel());
    await s.page.waitForSelector('#accountBox input[type=file][accept="image/*"]', { state: 'attached' });
    await s.page.setInputFiles('#accountBox input[type=file][accept="image/*"]', { name: 'foto.png', mimeType: 'image/png', buffer: PNG_1PX });
    await esperar(() => supa.usuarios.get(USER.id).user_metadata.avatar_path);
  };
  await subir();
  const p1 = supa.usuarios.get(USER.id).user_metadata.avatar_path;
  assert.match(p1, new RegExp('^' + USER.id + '/avatar-\\d+\\.jpg$'));
  assert.equal(supa.objetos.get(p1).tipo, 'image/jpeg');
  assert.equal('avatar_data' in supa.usuarios.get(USER.id).user_metadata, false);
  await esperar(async () => (await tokenActual(s.page)).includes('.') && (await cookieSesion(s.ctx))?.value === await tokenActual(s.page));
  await s.page.evaluate(() => document.getElementById('accountBox')?.close?.());
  await new Promise(r => setTimeout(r, 30));
  await s.page.evaluate(() => document.getElementById('accountBox')?.remove());
  await new Promise(r => setTimeout(r, 1100));
  await subir();
  await esperar(() => supa.usuarios.get(USER.id).user_metadata.avatar_path !== p1);
  const p2 = supa.usuarios.get(USER.id).user_metadata.avatar_path;
  await esperar(() => !supa.objetos.has(p1));
  assert.deepEqual(objetosDe(USER.id), [p2], 'solo queda la foto vigente');
  await s.page.click('#accountBox button:has-text("Eliminar foto")');
  await esperar(() => !('avatar_path' in supa.usuarios.get(USER.id).user_metadata));
  await esperar(() => objetosDe(USER.id).length === 0);
  assert.deepEqual(errores(s), []);
  await s.ctx.close();
});

test('guardar el nombre después de una migración en segundo plano no vuelve a incrustar la foto en el JWT', async () => {
  conFoto();
  const s = await abrirReal(browser, { sesion: emitirSesion('usuario-con-foto') });
  await entrarAlEditor(s.page);
  await s.page.evaluate(() => accountPanel());
  await esperar(() => !('avatar_data' in supa.usuarios.get('usuario-con-foto').user_metadata), 15000);
  const nombre = s.page.locator('#accountBox label', { hasText: 'Nombre visible' }).locator('input');
  await nombre.fill('Ana Renombrada');
  await s.page.click('#accountBox button:has-text("Guardar cambios")');
  await esperar(() => supa.usuarios.get('usuario-con-foto').user_metadata.full_name === 'Ana Renombrada');
  const m = supa.usuarios.get('usuario-con-foto').user_metadata;
  assert.equal('avatar_data' in m, false);
  assert.equal(m.avatar_path, 'usuario-con-foto/avatar-migrado.jpg');
  await s.ctx.close();
});

test('proyectos tras migrar y renovar: listar, abrir, editar y guardar en Supabase siguen funcionando con el token nuevo', async () => {
  conFoto();
  const ahora = Date.now();
  const datos = JSON.stringify({ nm: 'Casa', v: 2, w: [{ id: 1, x1: 0, y1: 0, x2: 300, y2: 0, t: 10, h: 250 }], o: [], i: [] });
  const s = await abrirReal(browser, { sesion: emitirSesion('usuario-con-foto'), guardado: { p1: { id: 'p1', name: 'Casa', created: ahora, updated: ahora, data: datos, versions: [] } } });
  await entrarAlEditor(s.page);
  await esperar(() => cookieSesion(s.ctx), 15000);
  await s.page.evaluate(() => openProj('p1'));
  await s.page.waitForFunction(() => S.w.length === 1);
  await s.page.evaluate(() => { S.w[0].h = 265; psave(); });
  await s.page.waitForFunction(() => document.getElementById('saveCloudState')?.dataset.state === 'synced', null, { timeout: 8000 });
  assert.equal(JSON.parse(estadoSupabase.proyectos.get('p1').data).w[0].h, 265);
  assert.deepEqual(errores(s), []);
  await s.ctx.close();
});
