// R1.3 · Suspensión de bucles: en reposo no se ejecuta ningún callback gráfico (requestAnimationFrame) en ningún modo,
// y el motor despierta al instante con interacciones reales, ediciones, cargas asíncronas, cambios de tamaño, cambio de
// pestaña e invalidaciones explícitas, incluso tras un reposo prolongado. Nunca hay bucles duplicados.
// Ejecutar: node --test tests/suspension-bucles.test.mjs   (Chrome en CHROME_BIN)
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium, abrirReal, entrarAlEditor } from './harness/real-harness.mjs';
import { prepararProyecto, glbPrueba } from './harness/glb-prueba.mjs';

let browser;
test.before(async () => { browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }); });
test.after(async () => { await browser?.close(); });

async function editor(tamano = [2, 1, 6]) {
  const s = await abrirReal(browser);
  // Cuenta TODOS los callbacks de requestAnimationFrame (por nombre) y las solicitudes pendientes.
  await s.ctx.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window), vivos = new Map();
    window.__raf = {}; window.__pendientes = () => { const p = {}; for (const k of vivos.values()) p[k] = (p[k] || 0) + 1; return p; };
    window.requestAnimationFrame = cb => { const k = cb.name || 'anónima'; const id = raf(t => { vivos.delete(id); window.__raf[k] = (window.__raf[k] || 0) + 1; cb(t); }); vivos.set(id, k); return id; };
    window.cancelAnimationFrame = id => { vivos.delete(id); return caf(id); };
  });
  await entrarAlEditor(s.page);
  await prepararProyecto(s.page, tamano);
  await s.page.evaluate(() => {
    window.__renders = new Map();
    const envolver = r => { if (!r || __renders.has(r)) return r; __renders.set(r, 0); const o = r.render; r.render = function () { __renders.set(r, __renders.get(r) + 1); return o.apply(this, arguments); }; return r; };
    envolver(r3); envolver(r4);
    const crear = window.createWebGLRenderer; window.createWebGLRenderer = function () { return envolver(crear.apply(this, arguments)); };
    window.__n = r => __renders.get(r) || 0;
    window.__total = () => Object.values(__raf).reduce((a, b) => a + b, 0);
    window.__esperar = ms => new Promise(ok => setTimeout(ok, ms));
    window.__modo = async m => { if (m === '2d') setMode('2d'); else if (m === 'dual') setMode('dual'); else { if (mode !== '3d' || dualView) setMode('3d'); $('#sq').value = m; setQ(); } };
    // Tiempo (ms) desde un cambio hasta el siguiente dibujo de r3, medido con temporizadores (no con rAF, que despertaría).
    window.__msHastaDibujo = async (cambio, renderer = r3) => { const r0 = __n(renderer), t0 = performance.now(); await cambio(); while (performance.now() - t0 < 3000) { if (__n(renderer) > r0) return Math.round(performance.now() - t0); await __esperar(5); } return Infinity; };
  });
  return s;
}
// Reposo: tras asentarse, ningún callback de rAF ni dibujo durante `ms`.
const reposo = (page, ms = 3000) => page.evaluate(async ms => { await __esperar(2500); const c = __total(), d = __n(r3); await __esperar(ms); return { callbacks: __total() - c, dibujos: __n(r3) - d, pendientes: __pendientes() }; }, ms);

test('reposo: ningún callback gráfico ni dibujo en 2D, materiales, Realista y vista dual', async () => {
  const s = await editor();
  for (const m of ['2d', 'm', 'q', 'dual']) {
    await s.page.evaluate(m => __modo(m), m);
    const r = await reposo(s.page);
    assert.equal(r.callbacks, 0, `${m}: callbacks de rAF en reposo ${JSON.stringify(r.pendientes)}`);
    assert.equal(r.dibujos, 0, `${m}: dibujos en reposo`);
    assert.deepEqual(r.pendientes, {}, `${m}: ninguna solicitud de rAF pendiente`);
  }
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('reactivación tras un reposo prolongado (10 s): cada cambio se dibuja de inmediato', async () => {
  const s = await editor();
  await s.page.evaluate(() => __modo('q'));
  const r = await s.page.evaluate(async () => {
    await __esperar(10000);                                         // suspendido de verdad
    const suspendido = Object.keys(__pendientes()).length === 0;
    const res = { suspendido };
    res.edicion = await __msHastaDibujo(() => { S.i[0].x += 3; commit(); });
    await __esperar(1500); res.sol = await __msHastaDibujo(() => { $('#sa').value = String((+$('#sa').value + 20) % 360); setSun(); });
    await __esperar(1500); res.invalidacionExplicita = await __msHastaDibujo(() => { root.children[0].position.y += 0.5; invalidateScene(); });
    await __esperar(1500); res.camaraExplicita = await __msHastaDibujo(() => { cam.position.x += 10; keepRendering(); });
    await __esperar(1500); res.sombrasInteriores = await __msHastaDibujo(() => invalidateInteriorShadows());
    await __esperar(1500); res.material = await __msHastaDibujo(() => { let m = null; root.traverse(o => { if (!m && o.isMesh && !Array.isArray(o.material)) m = o.material; }); m.color.offsetHSL(.05, 0, 0); m.needsUpdate = true; });
    // Solo el ResizeObserver de #view (como al plegar un panel o cambiar la ventana): sin eventos de usuario.
    const vista = $('#view');
    await __esperar(1500); res.tamano = await __msHastaDibujo(() => { vista.style.width = (vista.clientWidth - 60) + 'px'; });
    vista.style.width = '';
    return res;
  });
  assert.ok(r.suspendido, 'tras 10 s el motor estaba suspendido');
  for (const [k, v] of Object.entries(r)) if (k !== 'suspendido') assert.ok(v < 500, `${k}: se dibuja en ${v} ms tras despertar`);
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('vistas fijadas por código tras reposo (arranque asíncrono, botones de vista, encuadre): se dibujan sin interacción', async () => {
  const s = await editor();
  await s.page.evaluate(() => __modo('m'));
  const r = await s.page.evaluate(async () => {
    const res = {};
    // Llamadas desde temporizadores, como la órbita de arranque que llega cuando termina de abrirse el proyecto.
    const enTemporizador = f => () => new Promise(ok => setTimeout(() => { f(); ok(); }, 0));
    await __esperar(4000); res.suspendido = Object.keys(__pendientes()).length === 0;
    res.planta = await __msHastaDibujo(enTemporizador(() => vw('top')));
    await __esperar(2500); res.iso = await __msHastaDibujo(enTemporizador(() => vw('iso')));
    await __esperar(2500); res.encuadre = await __msHastaDibujo(enTemporizador(() => { cam.position.x += 200; frameProject(null); }));
    await __esperar(2500); res.orbita = await __msHastaDibujo(enTemporizador(() => showOrbit(true)));
    // La órbita automática mantiene el motor activo mientras gira.
    const d0 = __n(r3); await __esperar(1000); res.dibujosGirando = __n(r3) - d0;
    stopOrbit(); keepRendering();
    await __esperar(3000); const c = __total(), d1 = __n(r3); await __esperar(2000);
    res.reposoTrasOrbita = { callbacks: __total() - c, dibujos: __n(r3) - d1 };
    if ((S.rooms || []).some(room => room.poly?.length >= 3)) res.interior = await __msHastaDibujo(enTemporizador(() => interiorCamera()));
    return res;
  });
  assert.ok(r.suspendido, 'antes de cada vista el motor estaba suspendido');
  for (const k of ['planta', 'iso', 'encuadre', 'orbita', 'interior']) if (k in r) assert.ok(r[k] < 500, `${k}: se dibuja en ${r[k]} ms`);
  assert.ok(r.dibujosGirando >= 3, `la órbita automática sigue dibujando (${r.dibujosGirando} dibujos en 1 s)`);
  assert.deepEqual(r.reposoTrasOrbita, { callbacks: 0, dibujos: 0 }, 'al parar la órbita el bucle vuelve a suspenderse');
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('interacciones reales tras reposo: arrastre, rueda y WASD despiertan y son fluidas', async () => {
  const s = await editor();
  await s.page.evaluate(() => __modo('m'));
  await s.page.waitForTimeout(4000);
  const c = await s.page.evaluate(() => { const r = r3.domElement.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  // Rueda (zoom)
  let d0 = await s.page.evaluate(() => __n(r3));
  await s.page.mouse.move(c.x, c.y); await s.page.mouse.wheel(0, -200); await s.page.waitForTimeout(400);
  assert.ok(await s.page.evaluate(() => __n(r3)) > d0, 'la rueda despierta y dibuja');
  // Arrastre: un dibujo por fotograma mientras se arrastra
  await s.page.mouse.down(); await s.page.mouse.move(c.x + 5, c.y);
  const a = await s.page.evaluate(() => ({ d: __n(r3), c: __raf.animate || 0 }));
  for (let i = 0; i < 40; i++) { await s.page.mouse.move(c.x + 90 * Math.sin(i / 5), c.y + 25 * Math.cos(i / 7)); await s.page.waitForTimeout(16); }
  const b = await s.page.evaluate(() => ({ d: __n(r3), c: __raf.animate || 0 }));
  await s.page.mouse.up();
  assert.ok(b.c - a.c > 3 && b.d - a.d >= (b.c - a.c) * .9, `arrastre fluido (${b.d - a.d} dibujos / ${b.c - a.c} fotogramas)`);
  // Inercia: sigue hasta detenerse y después se suspende
  const quieta = await s.page.evaluate(async () => { for (let i = 0; i < 600; i++) { await __esperar(100); if (Object.keys(__pendientes()).length === 0) return true; } return false; });
  assert.ok(quieta, 'al terminar la inercia de la órbita el bucle se suspende');
  // WASD
  await s.page.evaluate(() => r3.domElement.focus());
  await s.page.keyboard.down('w'); await s.page.waitForTimeout(150);
  const w0 = await s.page.evaluate(() => ({ d: __n(r3), x: cam.position.x, z: cam.position.z }));
  await s.page.waitForTimeout(1200);
  const w1 = await s.page.evaluate(() => ({ d: __n(r3), x: cam.position.x, z: cam.position.z }));
  await s.page.keyboard.up('w');
  assert.ok(Math.hypot(w1.x - w0.x, w1.z - w0.z) > 1 && w1.d > w0.d, 'WASD mueve y dibuja');
  const r = await reposo(s.page, 2000);
  assert.equal(r.callbacks, 0, 'tras soltar la tecla vuelve a suspenderse');
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('cargas asíncronas tras reposo: un modelo GLB nuevo y una textura que llega después se dibujan solas', async () => {
  const s = await editor([1, 1, 4]);
  await s.page.evaluate(() => __modo('m'));
  const glb = glbPrueba().toString('base64');
  const r = await s.page.evaluate(async glb => {
    await __esperar(5000);
    const suspendido = Object.keys(__pendientes()).length === 0;
    // GLB: se analiza de forma asíncrona y se coloca (refresh → reconstrucción).
    const bin = atob(glb), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const d0 = __n(r3);
    await addModel({ id: 'glb-asincrono', name: 'GLB asíncrono', ext: 'glb', data: bytes.buffer, units: 1 });
    S.i.push({ t: 'model', mid: 'glb-asincrono', n: 'GLB asíncrono', c: 'Mi biblioteca', w: 80, h: 74, d: 70, e: 0, col: '#888888', id: nid(), x: 200, y: 200, r: 0, op: [] });
    refresh(); await __esperar(800);
    const glbDibujado = __n(r3) > d0;
    // Textura: la imagen termina de cargar más tarde (TextureLoader → needsUpdate) sin ninguna interacción.
    await __esperar(2000);
    let mesh = null; root.traverse(o => { if (!mesh && o.isMesh && !Array.isArray(o.material) && o.material.isMeshStandardMaterial) mesh = o; });
    const lienzo = document.createElement('canvas'); lienzo.width = lienzo.height = 8; lienzo.getContext('2d').fillRect(0, 0, 8, 8);
    const d1 = __n(r3), t0 = performance.now();
    const tex = await new Promise(ok => { const t = new T.TextureLoader().load(lienzo.toDataURL(), () => ok(t)); mesh.material.map = t; });
    let ms = Infinity; while (performance.now() - t0 < 3000) { if (__n(r3) > d1) { ms = Math.round(performance.now() - t0); break; } await __esperar(5); }
    return { suspendido, glbDibujado, texturaMs: ms, textura: !!tex.image };
  }, glb);
  assert.ok(r.suspendido, 'estaba suspendido antes de las cargas');
  assert.ok(r.glbDibujado, 'el modelo GLB cargado de forma asíncrona se dibuja');
  assert.ok(r.textura && r.texturaMs < 1500, `la textura asíncrona se dibuja al llegar (${r.texturaMs} ms)`);
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('puertas y cajones: la animación es continua hasta terminar y después el bucle se suspende', async () => {
  const s = await editor([1, 1, 6]);
  await s.page.evaluate(() => __modo('m'));
  const r = await s.page.evaluate(async () => {
    await __esperar(3000);
    const motion = MV[0]; if (!motion) return { sinPuertas: true };
    const d0 = __n(r3), v0 = motion.v;
    motion.it.op[motion.k] = !motion.it.op[motion.k]; keepRendering();   // como el clic que abre la puerta
    await __esperar(1500);
    const durante = __n(r3) - d0, avance = Math.abs(motion.v - v0);
    for (let i = 0; i < 200; i++) { await __esperar(100); if (Object.keys(__pendientes()).length === 0) break; }
    const c = __total(); await __esperar(1500);
    return { durante, avance, callbacksAlFinal: __total() - c };
  });
  assert.ok(!r.sinPuertas, 'el proyecto de prueba tiene puertas o cajones');
  assert.ok(r.avance > .3 && r.durante > 3, `la puerta se anima dibujando (${r.durante} dibujos, avance ${r.avance.toFixed(2)})`);
  assert.equal(r.callbacksAlFinal, 0, 'al terminar la animación se suspende');
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('pestaña oculta y regreso: sin actividad oculta, reactivación al volver y sin bucles duplicados', async () => {
  const s = await editor();
  await s.page.evaluate(() => __modo('m')); await s.page.waitForTimeout(3000);
  const otra = await s.ctx.newPage(); await otra.goto('about:blank'); await otra.bringToFront();
  await s.page.waitForTimeout(2000);
  const d0 = await s.page.evaluate(() => __n(r3));
  await s.page.bringToFront();
  await s.page.evaluate(() => { cam.position.x += 8; document.dispatchEvent(new Event('visibilitychange')); });
  await s.page.waitForTimeout(800);
  const r = await s.page.evaluate(d0 => ({ dibujaAlVolver: __n(r3) > d0, pendientes: __pendientes() }), d0);
  assert.ok(r.dibujaAlVolver, 'al volver a la pestaña el motor se reactiva');
  assert.ok((r.pendientes.animate || 0) <= 1, 'un solo bucle de animate');
  const q = await reposo(s.page, 2000);
  assert.equal(q.callbacks, 0, 'y vuelve a suspenderse');
  await otra.close();
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('sin bucles duplicados: despertares masivos, llamadas directas y cambios de modo dejan un único fotograma pendiente', async () => {
  const s = await editor();
  const r = await s.page.evaluate(async () => {
    let max = 0; const mira = () => { max = Math.max(max, __pendientes().animate || 0); };
    for (const m of ['m', 'q', 'dual', '2d', 'm']) { await __modo(m); mira(); for (let i = 0; i < 50; i++) { keepRendering(); invalidateScene(); mira(); } animate(); mira(); animate(); mira(); await __esperar(200); mira(); }
    return max;
  });
  assert.ok(r <= 1, `máximo de solicitudes pendientes de animate: ${r}`);
  const q = await reposo(s.page, 2000);
  assert.equal(q.callbacks, 0, 'después de todo, suspendido');
  assert.deepEqual(s.errores, []);
  await s.ctx.close();
});

test('vista previa y Ver en Realidad: se suspenden en reposo y despiertan al tocarlas', async () => {
  const s = await editor([1, 1, 3]);
  await s.page.evaluate(async () => { openPrevObj(LIB.find(x => x.t === 'sofa') || LIB[0]); });
  let r = await reposo(s.page, 2000);
  assert.equal(r.callbacks, 0, 'vista previa quieta: sin callbacks');
  const giro = await s.page.evaluate(() => __msHastaDibujo(() => { cam4.position.x += 15; keepRendering(); }, r4));
  assert.ok(giro < 500, 'la vista previa despierta: ' + giro);
  await s.page.evaluate(() => closePreview());
  await s.page.evaluate(async () => { await __modo('m'); realMode(); });
  r = await reposo(s.page, 2000);
  assert.equal(r.callbacks, 0, 'Ver en Realidad quieto: sin callbacks');
  const ajuste = await s.page.evaluate(async () => {
    const rr = [...__renders.keys()].find(x => x !== r3 && x !== r4 && x.domElement.closest('.nuhio-render-stage'));
    const input = document.querySelector('.nuhio-render-settings input[type=range]');
    return __msHastaDibujo(() => { input.value = String(+input.min + (+input.max - +input.min) * .41); input.dispatchEvent(new Event('input', { bubbles: true })); }, rr);
  });
  assert.ok(ajuste < 500, 'un ajuste despierta la vista en vivo: ' + ajuste);
  await s.page.evaluate(() => document.querySelector('.nuhio-render-exit').click());
  r = await reposo(s.page, 2000);
  assert.equal(r.callbacks, 0, 'tras salir, todo suspendido');
  assert.deepEqual(s.errores.filter(e => !e.startsWith('dialog:')), []);
  await s.ctx.close();
});
