// GLB real y mínimo para las pruebas: dos primitivas (cuerpo y tablero) con dos materiales PBR, subdivididas para
// superar el mínimo de 1.500 triángulos que exige el editor al importar modelos.
export function glbPrueba() {
  const caja = (sx, sy, sz, oy, N = 12) => {
    const p = [], n = [], i = [], s = [sx / 2, sy / 2, sz / 2];
    for (const [a, b, c, d] of [[0, 1, 2, 1], [0, 1, 2, -1], [1, 2, 0, 1], [1, 2, 0, -1], [2, 0, 1, 1], [2, 0, 1, -1]]) {
      const base = p.length / 3;
      for (let y = 0; y <= N; y++) for (let x = 0; x <= N; x++) {
        const q = [0, 0, 0]; q[a] = (x / N * 2 - 1) * s[a]; q[b] = (y / N * 2 - 1) * s[b]; q[c] = d * s[c]; q[1] += oy; p.push(...q);
        const nn = [0, 0, 0]; nn[c] = d; n.push(...nn);
      }
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const v = base + y * (N + 1) + x, t = [v, v + 1, v + N + 2, v, v + N + 2, v + N + 1];
        i.push(...(d > 0 ? t : [t[0], t[2], t[1], t[3], t[5], t[4]]));
      }
    }
    return { p: new Float32Array(p), n: new Float32Array(n), i: new Uint16Array(i) };
  };
  const partes = [caja(60, 70, 60, 35), caja(80, 4, 70, 72)];
  const bufs = [], views = [], acc = []; let off = 0;
  const add = (arr, target) => { const b = Buffer.from(arr.buffer); const pad = (4 - b.length % 4) % 4; bufs.push(b, Buffer.alloc(pad)); views.push({ buffer: 0, byteOffset: off, byteLength: b.length, target }); off += b.length + pad; return views.length - 1; };
  const prims = partes.map((g, k) => {
    const vp = add(g.p, 34962), vn = add(g.n, 34962), vi = add(g.i, 34963);
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let j = 0; j < g.p.length; j++) { mn[j % 3] = Math.min(mn[j % 3], g.p[j]); mx[j % 3] = Math.max(mx[j % 3], g.p[j]); }
    acc.push({ bufferView: vp, componentType: 5126, count: g.p.length / 3, type: 'VEC3', min: mn, max: mx }, { bufferView: vn, componentType: 5126, count: g.n.length / 3, type: 'VEC3' }, { bufferView: vi, componentType: 5123, count: g.i.length, type: 'SCALAR' });
    return { attributes: { POSITION: k * 3, NORMAL: k * 3 + 1 }, indices: k * 3 + 2, material: k };
  });
  const bin = Buffer.concat(bufs);
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: prims }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.55, 0.35, 0.2, 1], roughnessFactor: 0.6, metallicFactor: 0 } }, { pbrMetallicRoughness: { baseColorFactor: [0.9, 0.9, 0.88, 1], roughnessFactor: 0.3, metallicFactor: 0 } }],
    buffers: [{ byteLength: bin.length }], bufferViews: views, accessors: acc };
  let js = Buffer.from(JSON.stringify(json)); js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
  const h = Buffer.alloc(12); h.writeUInt32LE(0x46546C67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + js.length + 8 + bin.length, 8);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(js.length, 0); c1.writeUInt32LE(0x4E4F534A, 4);
  const c2 = Buffer.alloc(8); c2.writeUInt32LE(bin.length, 0); c2.writeUInt32LE(0x004E4942, 4);
  return Buffer.concat([h, c1, js, c2, bin]);
}

// Crea en la página un proyecto determinista: rejilla de salas con muebles de la biblioteca y un modelo GLB por sala.
export async function prepararProyecto(page, [cols, filas, porSala], { glb = true } = {}) {
  const glbB64 = glb ? glbPrueba().toString('base64') : '';
  await page.evaluate(async ([cols, filas, porSala, glbB64]) => {
    if (glbB64 && !MODS['glb-prueba']) {
      const bin = atob(glbB64), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await addModel({ id: 'glb-prueba', name: 'Aparador GLB', ext: 'glb', data: bytes.buffer, units: 1 });
    }
    S = migrate({ w: [], o: [], i: [], cm: [], ms: [], rooms: [], rv: [], id: 1 });
    const lib = LIB.filter(x => x.t && !x.lk && x.t !== 'model'); let k = 0;
    for (let c = 0; c < cols; c++) for (let f = 0; f < filas; f++) {
      const x0 = c * 420, y0 = f * 370; room(x0, y0, 400, 350);
      for (let n = 0; n < porSala; n++) S.i.push(Object.assign(JSON.parse(JSON.stringify(lib[k++ % lib.length])), { id: nid(), x: x0 + 50 + (n % 4) * 90, y: y0 + 60 + Math.floor(n / 4) * 100, r: 0, op: [] }));
      if (glbB64) S.i.push({ t: 'model', mid: 'glb-prueba', n: 'Aparador GLB', c: 'Mi biblioteca', w: 80, h: 74, d: 70, e: 0, col: '#888888', id: nid(), x: x0 + 300, y: y0 + 280, r: 0, op: [] });
    }
    roomsUpdate(); $('#sq').value = 'm'; setMode('2d');
  }, [cols, filas, porSala, glbB64]);
}
