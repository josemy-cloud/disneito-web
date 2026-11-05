
const SUPABASE_URL = "https://aqfqwvzbsbjrixzgxtro.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxZnF3dnpic2Jqcml4emd4dHJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM1NTA5MjMsImV4cCI6MjEwOTEyNjkyM30.VWRIowVOECv7ycW3Nnpz-EQNJx2izM7yx7xOxkNWVZo";
const FOTO_IA_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

function fotoIAB64Url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fotoIADecodeB64Url(value) {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), ch => ch.charCodeAt(0));
}
async function fotoIAHmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function createFotoIAMasterToken(secret, deviceId) {
  const now = Math.floor(Date.now() / 1000);
  const header = fotoIAB64Url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = fotoIAB64Url(new TextEncoder().encode(JSON.stringify({ typ: "fotoia-master-test", aud: "disenito-fotoia", device: deviceId, iat: now, exp: now + 1800 })));
  const input = header + "." + payload;
  const signature = await crypto.subtle.sign("HMAC", await fotoIAHmacKey(secret), new TextEncoder().encode(input));
  return input + "." + fotoIAB64Url(signature);
}
async function verifyFotoIAMasterToken(secret, token, deviceId) {
  if (!secret || !token || typeof token !== "string") return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const input = parts[0] + "." + parts[1];
    const valid = await crypto.subtle.verify("HMAC", await fotoIAHmacKey(secret), fotoIADecodeB64Url(parts[2]), new TextEncoder().encode(input));
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(fotoIADecodeB64Url(parts[1])));
    const now = Math.floor(Date.now() / 1000);
    return payload.typ === "fotoia-master-test" && payload.aud === "disenito-fotoia" && payload.device === deviceId &&
      Number.isFinite(payload.iat) && Number.isFinite(payload.exp) && payload.iat <= now + 60 && payload.exp > now &&
      payload.exp - payload.iat === 1800;
  } catch (error) { return false; }
}
async function fotoIAMasterAccess(request, env, user, deviceId) {
  if (user && env.MASTER_USER_ID && user.id === env.MASTER_USER_ID) return { master: true, mode: "account" };
  const token = request.headers.get("X-Master-Test-Session") || "";
  if (token && await verifyFotoIAMasterToken(env.MASTER_TEST_SECRET, token, deviceId)) return { master: true, mode: "anonymous-test" };
  return { master: false, mode: "normal", attempted: !!token };
}
async function fotoIAMasterStats(env) {
  if (!env.MASTER_TEST_STATS) return null;
  try { return Number(await env.MASTER_TEST_STATS.get("fotoia:master:total") || 0); }
  catch (error) { return null; }
}
async function fotoIARecordMasterGeneration(env) {
  if (!env.MASTER_TEST_STATS) return;
  try {
    const key = "fotoia:master:total";
    const value = Number(await env.MASTER_TEST_STATS.get(key) || 0);
    await env.MASTER_TEST_STATS.put(key, String(value + 1));
  } catch (error) { console.error("No se pudo registrar el uso de pruebas MASTER:", error); }
}


async function getSupabaseUser(token) {
  const r = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token }
  });
  if (!r.ok) return null;
  const user = await r.json().catch(() => null);
  return user && user.id ? user : null;
}

function madridDayBounds(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    timeZoneName: "longOffset"
  }).formatToParts(now);
  const get = type => parts.find(p => p.type === type)?.value;
  const date = get("year") + "-" + get("month") + "-" + get("day");
  const offset = (get("timeZoneName") || "GMT").match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  const offsetMinutes = offset ? (offset[1] === "+" ? 1 : -1) * (Number(offset[2]) * 60 + Number(offset[3] || 0)) : 0;
  const [y, m, d] = date.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d) - offsetMinutes * 60000);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { date, start: start.toISOString(), end: end.toISOString() };
}


async function fotoIARpc(token, functionName, args = {}) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + functionName, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + (token || SUPABASE_ANON_KEY),
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args)
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.message || data?.details || data?.error || "Error al consultar el límite de Foto IA (" + r.status + ").");
  return data;
}

async function countFotoIARows(token, userId, start, end) {
  const q = new URLSearchParams({ select: "id", user_id: "eq." + userId });
  if (start) q.set("created_at", "gte." + start);
  if (end) q.append("created_at", "lt." + end);
  const r = await fetch(SUPABASE_URL + "/rest/v1/foto_ia_generaciones?" + q.toString(), {
    method: "HEAD",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + token,
      Prefer: "count=exact",
      Range: "0-0"
    }
  });
  if (!r.ok) throw new Error("No se pudieron consultar las estadísticas (" + r.status + ").");
  const range = r.headers.get("Content-Range") || "";
  const total = Number((range.split("/")[1] || "0").replace("*", "0"));
  return Number.isFinite(total) ? total : 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Estado del backend
    if (url.pathname === "/api/estado") {
      return Response.json({
        ok: true,
        servicio: "backend-pruebas",
        ia: env.AI ? "disponible" : "no configurada",
        mensaje: "El backend funciona correctamente."
      }, {
        headers: { "Cache-Control": "no-store" }
      });
    }

    // Generación de imagen desde texto
    if (url.pathname === "/api/ia/prueba") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "Utiliza POST." },
          { status: 405 }
        );
      }

      try {
        const form = new FormData();
        form.append(
          "prompt",
          "A photorealistic modern living room, natural daylight, realistic materials and professional interior photography."
        );
        form.append("width", "256");
        form.append("height", "256");

        const serialized = new Response(form);

        const result = await env.AI.run(
          "@cf/black-forest-labs/flux-2-klein-4b",
          {
            multipart: {
              body: serialized.body,
              contentType: serialized.headers.get("content-type")
            }
          }
        );

        const binary = Uint8Array.from(
          atob(result.image),
          c => c.charCodeAt(0)
        );

        return new Response(binary, {
          headers: { "Content-Type": "image/png" }
        });

      } catch (error) {
        return Response.json({
          error: String(error.message || error)
        }, { status: 500 });
      }
    }

    // Autoriza el modo anónimo MASTER mediante un secreto privado del Worker.
    if (url.pathname === "/api/master/test-session") {
      if (request.method !== "POST") return Response.json({ error: "Utiliza POST." }, { status: 405 });
      const deviceId = request.headers.get("X-FotoIA-Device") || "";
      const suppliedKey = request.headers.get("X-Master-Test-Key") || "";
      if (!env.MASTER_TEST_SECRET) return Response.json({ error: "El modo de pruebas MASTER no está configurado en el servidor." }, { status: 503 });
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId) ||
          !suppliedKey || suppliedKey.length > 256 || suppliedKey !== env.MASTER_TEST_SECRET) {
        return Response.json({ error: "Autorización MASTER no válida." }, { status: 403 });
      }
      const session = await createFotoIAMasterToken(env.MASTER_TEST_SECRET, deviceId);
      return Response.json({ ok: true, token: session, expiresIn: 1800 }, { headers: { "Cache-Control": "no-store" } });
    }

    // Estadísticas personales de Foto IA (día natural de España).
    if (url.pathname === "/api/ia/estadisticas") {
      if (request.method !== "GET") return Response.json({ error: "Utiliza GET." }, { status: 405 });
      try {
        const rawToken = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
        const deviceId = request.headers.get("X-FotoIA-Device") || "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
          return Response.json({ error: "No se ha podido identificar este dispositivo. Recarga la aplicación." }, { status: 400 });
        }
        let user = null;
        if (rawToken) {
          user = await getSupabaseUser(rawToken);
          if (!user) return Response.json({ error: "La sesión ha caducado. Vuelve a entrar en «Mis proyectos»." }, { status: 401 });
        }
        const master = await fotoIAMasterAccess(request, env, user, deviceId);
        if (master.master) {
          return Response.json({ ok: true, master: true, modoPruebas: master.mode, registrado: !!user,
            ilimitado: true, disponibles: null, limite: null, generacionesPrueba: await fotoIAMasterStats(env) },
            { headers: { "Cache-Control": "no-store" } });
        }
        if (master.attempted) return Response.json({ error: "La sesión de pruebas MASTER ha caducado. Actívala de nuevo." }, { status: 401 });
        const stats = await fotoIARpc(rawToken, "foto_ia_estadisticas", { p_device_id: deviceId });
        return Response.json({ ...stats, ok: true, zonaHoraria: "Europe/Madrid" }, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        return Response.json({ error: "No se pudo consultar el límite de Foto IA.", detalle: String(error.message || error) }, { status: 502 });
      }
    }

    // Edición de una habitación usando una imagen de referencia
    if (url.pathname === "/api/ia/editar") {
      if (request.method !== "POST") return Response.json({ error: "Utiliza POST." }, { status: 405 });
      let reservation = null;
      let reservationToken = "";
      let deviceId = "";
      try {
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
        deviceId = request.headers.get("X-FotoIA-Device") || "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
          return Response.json({ error: "No se ha podido identificar este dispositivo. Recarga la aplicación." }, { status: 400 });
        }
        let user = null;
        if (token) {
          user = await getSupabaseUser(token);
          if (!user) return Response.json({ error: "La sesión ha caducado. Vuelve a entrar en «Mis proyectos»." }, { status: 401 });
        }
        const master = await fotoIAMasterAccess(request, env, user, deviceId);
        if (master.attempted && !master.master) return Response.json({ error: "La sesión de pruebas MASTER ha caducado. Actívala de nuevo." }, { status: 401 });
        if (!env.AI) return Response.json({ error: "Workers AI no está disponible." }, { status: 503 });

        const received = await request.formData();
        const image = received.get("imagen");
        const rawInventory = received.get("inventario");
        const inventory = typeof rawInventory === "string"
          ? rawInventory.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, " ").slice(0, 12000)
          : "";
        const rawLevel = Number(received.get("nivel"));
        const fidelity = Number.isFinite(rawLevel) ? Math.max(0, Math.min(100, rawLevel)) : 65;
        const fidelityInstruction = fidelity < 34
          ? "Allow stronger photographic interpretation of lighting and surface appearance, but do not change the room layout, architecture, object count or object positions."
          : fidelity < 67
            ? "Balance photorealism with design fidelity. Preserve the exact room layout, architecture, object count, furniture positions and proportions; improve only materials, textures, lighting, shadows and reflections."
            : "Prioritize strict design fidelity over creative interpretation. Preserve the exact geometry, architecture, object count, furniture positions, dimensions, cabinet fronts, handles (only if present), worktops (only if present), doors, windows and camera viewpoint. Do not invent or add any object or detail.";

        if (!image || typeof image === "string") return Response.json({ error: "No se ha recibido ninguna imagen." }, { status: 400 });
        if (!image.type.startsWith("image/")) return Response.json({ error: "El archivo no es una imagen." }, { status: 400 });
        if (image.size > 5 * 1024 * 1024) return Response.json({ error: "La imagen supera el límite de 5 MB." }, { status: 413 });

        if (!master.master) {
          reservationToken = token;
          reservation = await fotoIARpc(token, "foto_ia_reservar_generacion", { p_device_id: deviceId });
          if (!reservation || reservation.ok !== true) {
            return Response.json({
              error: "Has alcanzado el límite diario de Foto IA.",
              hoy: reservation?.hoy ?? 0,
              limite: reservation?.limite ?? (user ? 3 : 1),
              disponibles: 0,
              fecha: reservation?.fecha
            }, { status: 429, headers: { "Cache-Control": "no-store" } });
          }
        }

        const aiForm = new FormData();
        const sceneContext = inventory
          ? "\n\nSCENE OBJECT INVENTORY (trusted application metadata describing the screenshot; use it to disambiguate visible objects):\\n" + inventory +
            "\nTreat the inventory as object identity and category guidance, not as permission to add anything. If the screenshot appearance and inventory disagree, preserve the visible geometry and use the inventory only to identify the intended object. In particular, never confuse a bidet with a toilet, sink, bathtub or urinal; never confuse a bed with a sofa; and render cars as recognizable complete road vehicles with wheels, windows, bodywork, lights and correct proportions."
          : "";
        aiForm.append("prompt", "Transform this exact interior design screenshot into a highly photorealistic architectural interior photograph. " + fidelityInstruction + " Never add, remove, move or redesign objects. Do not invent handles, countertops, shelves, decorations or architectural features that are not clearly present in the reference image. Maintain the original camera viewpoint and perspective. The scene may contain distinct objects that must remain recognizable as their actual intended category. Reproduce complete, anatomically and functionally correct object forms, not generic geometric approximations. " + sceneContext);
        aiForm.append("input_image_0", image, "referencia.png");
        aiForm.append("width", "1024");
        aiForm.append("height", "768");
        const serialized = new Response(aiForm);
        const result = await env.AI.run(FOTO_IA_MODEL, {
          multipart: { body: serialized.body, contentType: serialized.headers.get("content-type") }
        });
        if (!result || !result.image) throw new Error("El modelo no ha devuelto una imagen.");
        const binary = Uint8Array.from(atob(result.image), c => c.charCodeAt(0));
        reservation = null;
        if (master.master) await fotoIARecordMasterGeneration(env);
        return new Response(binary, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "no-store",
            "X-FotoIA-Count-Synced": "true",
            "X-FotoIA-Master": master.master ? master.mode : "false"
          }
        });
      } catch (error) {
        if (reservation && reservation.id) {
          try {
            await fotoIARpc(reservationToken, "foto_ia_cancelar_generacion", {
              p_reserva_id: reservation.id,
              p_device_id: deviceId,
              p_es_anonima: reservation.es_anonima === true
            });
          } catch (cancelError) {
            // Si la cancelación falla, se conserva la reserva para no permitir superar el límite.
          }
        }
        return Response.json({ error: "Error al editar la habitación.", detalle: String(error.message || error) }, { status: 500 });
      }
    }

    // Catálogo compartido: autorización exclusiva mediante sesión real de Supabase.
    if (url.pathname.startsWith("/api/catalogo/")) {
      const kv = env.CATALOG_APPROVALS;
      if (!kv) return Response.json({ error: "El almacenamiento compartido del catálogo no está configurado." }, { status: 503 });
      const rawToken = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      let user = null;
      if (rawToken) user = await getSupabaseUser(rawToken);
      const isMaster = !!(user && env.MASTER_USER_ID && user.id === env.MASTER_USER_ID);
      const denied = () => isMaster ? null : Response.json({ error: "Solo la cuenta MASTER puede importar, modificar o aprobar muebles y objetos." }, { status: rawToken ? 403 : 401 });
      const noStore = { "Cache-Control": "no-store" };
      if (url.pathname === "/api/catalogo/permisos" && request.method === "GET") {
        if (rawToken && !user) return Response.json({ error: "La sesión ha caducado. Vuelve a entrar." }, { status: 401, headers: noStore });
        return Response.json({ ok: true, master: isMaster }, { headers: noStore });
      }
      if (url.pathname === "/api/catalogo/aprobaciones" && request.method === "GET") {
        try {
          const approvals = {}; let cursor;
          do {
            const page = await kv.list({ prefix: "approval:", cursor, limit: 1000 });
            await Promise.all(page.keys.map(async item => { const value = await kv.get(item.name); if (value) approvals[item.name.slice(9)] = JSON.parse(value); }));
            cursor = page.list_complete ? undefined : page.cursor;
          } while (cursor);
          return Response.json(approvals, { headers: noStore });
        } catch (error) { return Response.json({ error: "No se pudieron leer las aprobaciones." }, { status: 502 }); }
      }
      if (url.pathname === "/api/catalogo/aprobar" && request.method === "POST") {
        const no = denied(); if (no) return no;
        try {
          const body = await request.json(), id = String(body.productId || ""), status = body.status;
          if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id) || !["approved", "rejected"].includes(status)) return Response.json({ error: "Ficha o estado no válido." }, { status: 400 });
          await kv.put("approval:" + id, JSON.stringify({ status, updatedAt: new Date().toISOString(), updatedBy: user.id }));
          return Response.json({ ok: true, productId: id, status }, { headers: noStore });
        } catch (error) { return Response.json({ error: "No se pudo guardar la aprobación." }, { status: 400 }); }
      }
      if (url.pathname === "/api/catalogo/productos" && request.method === "GET") {
        try {
          const products = []; let cursor;
          do {
            const page = await kv.list({ prefix: "product:", cursor, limit: 1000 });
            const rows = await Promise.all(page.keys.map(async item => { const value = await kv.get(item.name); return value ? JSON.parse(value) : null; }));
            products.push(...rows.filter(Boolean)); cursor = page.list_complete ? undefined : page.cursor;
          } while (cursor);
          return Response.json({ products }, { headers: noStore });
        } catch (error) { return Response.json({ error: "No se pudo cargar el catálogo compartido." }, { status: 502 }); }
      }
      if (url.pathname === "/api/catalogo/productos" && request.method === "POST") {
        const no = denied(); if (no) return no;
        try {
          const body = await request.json();
          if (!body || !/^[a-zA-Z0-9_-]{1,120}$/.test(String(body.id || "")) || !String(body.nombre || "").trim()) return Response.json({ error: "Ficha de producto no válida." }, { status: 400 });
          const product = { ...body, id: String(body.id), visual_review: "pending", updatedAt: new Date().toISOString(), updatedBy: user.id };
          delete product.docId; delete product.fotos; delete product.commercialData;
          await kv.put("product:" + product.id, JSON.stringify(product));
          return Response.json({ ok: true, id: product.id }, { headers: noStore });
        } catch (error) { return Response.json({ error: "No se pudo guardar el producto compartido." }, { status: 400 }); }
      }
      if (url.pathname === "/api/catalogo/modelos" && request.method === "GET") {
        try {
          const models = []; let cursor;
          do {
            const page = await kv.list({ prefix: "model:", cursor, limit: 1000 });
            const rows = await Promise.all(page.keys.map(async item => {
              const value = await kv.get(item.name); if (!value) return null;
              const m = JSON.parse(value); return { id: m.id, name: m.name, brand: m.brand, ref: m.ref, author: m.author, source: m.source, lic: m.lic, cat: m.cat, units: m.units, ext: m.ext, date: m.date };
            }));
            models.push(...rows.filter(Boolean)); cursor = page.list_complete ? undefined : page.cursor;
          } while (cursor);
          return Response.json({ models }, { headers: noStore });
        } catch (error) { return Response.json({ error: "No se pudieron cargar los modelos compartidos." }, { status: 502 }); }
      }
      const modelId = url.pathname.startsWith("/api/catalogo/modelo/") ? decodeURIComponent(url.pathname.slice("/api/catalogo/modelo/".length)) : "";
      if (/^[a-zA-Z0-9_-]{1,120}$/.test(modelId) && request.method === "GET") {
        const value = await kv.get("model:" + modelId);
        return value ? new Response(value, { headers: { ...noStore, "Content-Type": "application/json" } }) : Response.json({ error: "Modelo no encontrado." }, { status: 404 });
      }
      if (url.pathname === "/api/catalogo/modelos" && request.method === "POST") {
        const no = denied(); if (no) return no;
        try {
          const body = await request.json();
          if (!body || !/^[a-zA-Z0-9_-]{1,120}$/.test(String(body.id || "")) || !["glb", "gltf", "obj"].includes(body.ext) || typeof body.data !== "string" || body.data.length > 23 * 1024 * 1024) return Response.json({ error: "Modelo no válido o demasiado grande (máximo aproximado 17 MB)." }, { status: 413 });
          await kv.put("model:" + body.id, JSON.stringify(body));
          return Response.json({ ok: true, id: body.id }, { headers: noStore });
        } catch (error) { return Response.json({ error: "No se pudo compartir el modelo 3D." }, { status: 400 }); }
      }
      return Response.json({ error: "Método o ruta de catálogo no admitidos." }, { status: 405 });
    }

    // Rutas API inexistentes
    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        { error: "Ruta API no encontrada" },
        { status: 404 }
      );
    }

    return env.ASSETS.fetch(request);
  }
};
