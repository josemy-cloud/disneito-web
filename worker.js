
const SUPABASE_URL = "https://aqfqwvzbsbjrixzgxtro.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxZnF3dnpic2Jqcml4emd4dHJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM1NTA5MjMsImV4cCI6MjEwOTEyNjkyM30.VWRIowVOECv7ycW3Nnpz-EQNJx2izM7yx7xOxkNWVZo";
const FOTO_IA_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

const SESSION_COOKIE = "__Host-disenito-session";
const NO_STORE = { "Cache-Control": "private, no-store" };

function bearer(request) {
  return /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") || "")?.[1] || "";
}

function sessionCookie(request) {
  return (request.headers.get("Cookie") || "").split(";").map(part => part.trim())
    .find(part => part.startsWith(SESSION_COOKIE + "="))?.slice(SESSION_COOKIE.length + 1) || "";
}

function sessionResponse(value, clear = false) {
  return new Response(null, { status: 204, headers: {
    ...NO_STORE,
    "Set-Cookie": SESSION_COOKIE + "=" + value + "; Path=/; Secure; HttpOnly; SameSite=Lax" +
      (clear ? "; Max-Age=0" : "")
  } });
}

async function getSupabaseUser(token) {
  const r = await fetch(SUPABASE_URL + "/auth/v1/user", {
    signal: AbortSignal.timeout(6000),
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + token }
  });
  if (r.status >= 500 || r.status === 429) throw new Error("Supabase Auth no está disponible.");
  if (!r.ok) return null;
  const user = await r.json().catch(() => null);
  return user && user.id ? user : null;
}

async function fotoIARpc(token, functionName, args = {}, apiKey = SUPABASE_ANON_KEY) {
  const r = await fetch(SUPABASE_URL + "/rest/v1/rpc/" + functionName, {
    method: "POST",
    headers: {
      apikey: apiKey,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args)
  });

  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.message || data?.details || data?.error || "Error al consultar el límite de Foto IA (" + r.status + ").");
  return data;
}

const FOTO_IA_DAILY_LIMIT = 2;
const isMasterAccount = (env, user) => !!(user && env.MASTER_USER_ID && user.id === env.MASTER_USER_ID);

async function fotoIAStats(env, token, userId) {
  const stats = await fotoIAQuota(env, token, userId, "consultar");
  const hoy = stats?.hoy ?? (Number.isSafeInteger(stats?.limite) && Number.isSafeInteger(stats?.disponibles)
    ? stats.limite - stats.disponibles : NaN);
  if (!Number.isSafeInteger(hoy) || hoy < 0) throw new Error("Contador de Foto IA inválido.");
  return { ...stats, hoy, limite: FOTO_IA_DAILY_LIMIT, disponibles: Math.max(0, FOTO_IA_DAILY_LIMIT - hoy) };
}

function fotoIALimitResponse(stats) {
  return Response.json({
    error: "Has alcanzado el límite diario de Foto IA. Se renueva a medianoche, hora peninsular española.",
    hoy: stats.hoy, limite: FOTO_IA_DAILY_LIMIT, disponibles: 0, fecha: stats.fecha
  }, { status: 429, headers: NO_STORE });
}

function fotoIAQuota(env, token, userId, operation, reservation) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (key) {
    return fotoIARpc(key, "foto_ia_cupo_cuenta", {
      p_user_id: userId, p_operacion: operation, p_reserva: reservation || null
    }, key);
  }

  // Deployment transition. Supabase keeps its existing authenticated quota until migration activation.
  const legacy = {
    consultar: "foto_ia_estadisticas",
    reservar: "foto_ia_reservar_generacion",
    cancelar: "foto_ia_cancelar_generacion"
  };
  const args = { p_device_id: userId };
  if (operation === "cancelar") Object.assign(args, { p_reserva_id: reservation, p_es_anonima: false });
  return fotoIARpc(token, legacy[operation], args);
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

    if (url.pathname === "/api/sesion") {
      const token = bearer(request);
      if (request.method === "GET") {
        // Confirm that the browser retained this session before navigating to the editor.
        return new Response(null, { status: token && token === sessionCookie(request) ? 204 : 401, headers: NO_STORE });
      }
      if (request.headers.get("Origin") !== url.origin) {
        return Response.json({ error: "Origen no autorizado." }, { status: 403, headers: NO_STORE });
      }
      if (request.method === "DELETE") {
        const activeToken = token || sessionCookie(request);
        if (activeToken) {
          await fetch(SUPABASE_URL + "/auth/v1/logout?scope=local", {
            method: "POST", headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + activeToken }
          }).catch(() => {});
        }
        return sessionResponse("", true);
      }
      if (request.method !== "POST") return new Response(null, { status: 405 });
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
        return Response.json({ error: "La sesión de la cuenta no es válida." }, { status: 401, headers: NO_STORE });
      }
      try {
        if (!await getSupabaseUser(token)) {
          return Response.json({ error: "Supabase rechazó la sesión. Vuelve a iniciar sesión." }, { status: 401, headers: NO_STORE });
        }
      } catch {
        return Response.json({ error: "Cloudflare no pudo verificar la sesión con Supabase. Inténtalo en unos segundos." }, { status: 503, headers: NO_STORE });
      }
      return sessionResponse(token);
    }

    if (url.pathname === "/api/editor") {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: NO_STORE });
      const token = bearer(request);
      try {
        if (!token || !await getSupabaseUser(token)) {
          return Response.json({ error: "Tu sesión ha caducado. Vuelve a iniciar sesión." }, { status: 401, headers: NO_STORE });
        }
      } catch {
        return Response.json({ error: "No se pudo validar la cuenta con Supabase." }, { status: 503, headers: NO_STORE });
      }

      const assetURL = new URL("/index.html", url.origin);
      let asset = await env.ASSETS.fetch(new Request(assetURL, { redirect: "manual" }));
      // Some preview asset configurations redirect /index.html to the directory URL.
      if ((asset.status >= 300 && asset.status < 400) || asset.status === 404) {
        assetURL.pathname = "/";
        asset = await env.ASSETS.fetch(new Request(assetURL, { redirect: "manual" }));
      }
      if (!asset.ok) {
        return Response.json({ error: "La versión publicada del editor no está disponible." }, { status: 502, headers: NO_STORE });
      }
      const headers = new Headers(asset.headers);
      headers.set("Cache-Control", NO_STORE["Cache-Control"]);
      headers.set("X-Disenito-Editor", "1");
      return new Response(asset.body, { status: 200, headers });
    }

    // Only the account-based generation path may invoke the image model.
    if (url.pathname === "/api/ia/prueba" || url.pathname === "/api/master/test-session") {
      return Response.json({ error: "Ruta retirada." }, { status: 410, headers: NO_STORE });
    }

    if (url.pathname === "/api/ia/estadisticas") {
      if (request.method !== "GET") return Response.json({ error: "Utiliza GET." }, { status: 405 });
      const token = bearer(request);
      try {
        const user = token && await getSupabaseUser(token);
        if (!user) return Response.json({ error: "Inicia sesión para continuar." }, { status: 401, headers: NO_STORE });
        const stats = isMasterAccount(env, user)
          ? { ilimitado: true, limite: null, disponibles: null }
          : await fotoIAStats(env, token, user.id);
        return Response.json({ ...stats, ok: true, zonaHoraria: "Europe/Madrid" }, { headers: NO_STORE });
      } catch {
        return Response.json({ error: "No se pudo consultar el límite de Foto IA." }, { status: 502, headers: NO_STORE });
      }
    }

    // Edición de una habitación usando una imagen de referencia
    if (url.pathname === "/api/ia/editar") {
      if (request.method !== "POST") return Response.json({ error: "Utiliza POST." }, { status: 405 });

      let reservation = null;
      let user = null;
      const token = bearer(request);

      try {
        user = token && await getSupabaseUser(token);
        if (!user) return Response.json({ error: "Inicia sesión para continuar." }, { status: 401, headers: NO_STORE });

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

        if (!image || typeof image === "string") {
          return Response.json({ error: "No se ha recibido ninguna imagen." }, { status: 400 });
        }

        if (!image.type.startsWith("image/")) {
          return Response.json({ error: "El archivo no es una imagen." }, { status: 400 });
        }

        if (image.size > 5 * 1024 * 1024) {
          return Response.json({ error: "La imagen supera el límite de 5 MB." }, { status: 413 });
        }

        if (!isMasterAccount(env, user)) {
          const legacyQuota = !env.SUPABASE_SERVICE_ROLE_KEY;
          if (legacyQuota) {
            const before = await fotoIAStats(env, token, user.id);
            if (before.disponibles === 0) return fotoIALimitResponse(before);
          }

          reservation = await fotoIAQuota(env, token, user.id, "reservar");
          if (reservation?.ok === false) return fotoIALimitResponse(reservation);
          if (reservation?.ok !== true || !reservation.id) throw new Error("Reserva inválida");

          if (legacyQuota) {
            // La reserva antigua permite tres. Verificar el total tras reservar
            // evita que dos solicitudes simultáneas excedan el cupo del Worker.
            const after = await fotoIAStats(env, token, user.id);
            if (after.hoy > FOTO_IA_DAILY_LIMIT) {
              await fotoIAQuota(env, token, user.id, "cancelar", reservation.id);
              reservation = null;
              return fotoIALimitResponse(after);
            }
          }
        }

        const aiForm = new FormData();

        const sceneContext = inventory
          ? "\n\nSCENE OBJECT INVENTORY (trusted application metadata describing the screenshot; use it to disambiguate visible objects):\\n" + inventory +
            "\nTreat the inventory as object identity and category guidance, not as permission to add anything. If the screenshot appearance and inventory disagree, preserve the visible geometry and use the inventory only to identify the intended object. In particular, never confuse a bidet with a toilet, sink, bathtub or urinal; never confuse a bed with a sofa; and render cars as recognizable complete road vehicles with wheels, windows, bodywork, lights and correct proportions."
          : "";

        aiForm.append(
          "prompt",
          "Transform this exact interior design screenshot into a highly photorealistic architectural interior photograph. " +
          fidelityInstruction +
          " Never add, remove, move or redesign objects. Do not invent handles, countertops, shelves, decorations or architectural features that are not clearly present in the reference image. Maintain the original camera viewpoint and perspective. The scene may contain distinct objects that must remain recognizable as their actual intended category. Reproduce complete, anatomically and functionally correct object forms, not generic geometric approximations. " +
          sceneContext
        );

        aiForm.append("input_image_0", image, "referencia.png");
        aiForm.append("width", "1024");
        aiForm.append("height", "768");

        const serialized = new Response(aiForm);

        const result = await env.AI.run(FOTO_IA_MODEL, {
          multipart: {
            body: serialized.body,
            contentType: serialized.headers.get("content-type")
          }
        });

        if (!result || !result.image) throw new Error("El modelo no ha devuelto una imagen.");

        const binary = Uint8Array.from(atob(result.image), c => c.charCodeAt(0));
        reservation = null;

        return new Response(binary, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "no-store",
            "X-FotoIA-Count-Synced": "true"
          }
        });
      } catch (error) {
        if (reservation && reservation.id) {
          try {
            await fotoIAQuota(env, token, user.id, "cancelar", reservation.id);
          } catch (cancelError) {
            // Si la cancelación falla, se conserva la reserva para no permitir superar el límite.
          }
        }

        return Response.json({
          error: "Error al editar la habitación."
        }, { status: 500 });
      }
    }

    // Catálogo compartido: autorización exclusiva mediante sesión real de Supabase.
    if (url.pathname.startsWith("/api/catalogo/")) {
      const rawToken = bearer(request) || sessionCookie(request);
      const user = rawToken && await getSupabaseUser(rawToken).catch(() => null);
      if (!user) return Response.json({ error: "Inicia sesión para continuar." }, { status: 401, headers: NO_STORE });

      const isMaster = isMasterAccount(env, user);

      const denied = () => isMaster
        ? null
        : Response.json(
            { error: "Solo la cuenta MASTER puede importar, modificar o aprobar muebles y objetos." },
            { status: rawToken ? 403 : 401 }
          );

      const noStore = { "Cache-Control": "no-store" };

      // La identidad MASTER se comprueba independientemente de que KV esté disponible.
      if (url.pathname === "/api/catalogo/permisos" && request.method === "GET") {
        return Response.json(
          { ok: true, master: isMaster, userId: user?.id || null },
          { headers: noStore }
        );
      }

      const kv = env.CATALOG_APPROVALS;

      if (!kv) {
        return Response.json(
          { error: "El almacenamiento compartido del catálogo no está configurado." },
          { status: 503, headers: noStore }
        );
      }

      // Leer las aprobaciones compartidas.
      if (url.pathname === "/api/catalogo/aprobaciones" && request.method === "GET") {
        try {
          const approvals = {};
          let cursor;

          do {
            const page = await kv.list({ prefix: "approval:", cursor, limit: 1000 });

            await Promise.all(page.keys.map(async item => {
              const value = await kv.get(item.name);
              if (value) approvals[item.name.slice(9)] = JSON.parse(value);
            }));

            cursor = page.list_complete ? undefined : page.cursor;
          } while (cursor);

          return Response.json(approvals, { headers: noStore });
        } catch (error) {
          return Response.json({ error: "No se pudieron leer las aprobaciones." }, { status: 502 });
        }
      }

      // Aprobar o rechazar productos: exclusivamente MASTER.
      if (url.pathname === "/api/catalogo/aprobar" && request.method === "POST") {
        const no = denied();
        if (no) return no;

        try {
          const body = await request.json();
          const id = String(body.productId || "");
          const status = body.status;

          if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id) ||
              !["approved", "rejected"].includes(status)) {
            return Response.json({ error: "Ficha o estado no válido." }, { status: 400 });
          }

          let exists = await kv.get("product:" + id);

          if (!exists) {
            const asset = await env.ASSETS.fetch(
              new Request(new URL("/catalogo/productos-comerciales.json", url.origin))
            );

            if (asset.ok) {
              const registry = await asset.json();
              exists = (registry.products || []).some(product => product.id === id) ? "static" : null;
            }
          }

          if (!exists) {
            return Response.json({ error: "No existe esa ficha en el catálogo." }, { status: 404 });
          }

          await kv.put(
            "approval:" + id,
            JSON.stringify({
              status,
              updatedAt: new Date().toISOString(),
              updatedBy: user.id
            })
          );

          return Response.json(
            { ok: true, productId: id, status },
            { headers: noStore }
          );
        } catch (error) {
          return Response.json({ error: "No se pudo guardar la aprobación." }, { status: 400 });
        }
      }

      // Consultar productos compartidos.
      if (url.pathname === "/api/catalogo/productos" && request.method === "GET") {
        try {
          const products = [];
          let cursor;

          do {
            const page = await kv.list({ prefix: "product:", cursor, limit: 1000 });

            const rows = await Promise.all(page.keys.map(async item => {
              const value = await kv.get(item.name);
              return value ? JSON.parse(value) : null;
            }));

            products.push(...rows.filter(Boolean));
            cursor = page.list_complete ? undefined : page.cursor;
          } while (cursor);

          return Response.json({ products }, { headers: noStore });
        } catch (error) {
          return Response.json({ error: "No se pudo cargar el catálogo compartido." }, { status: 502 });
        }
      }

      // Guardar productos compartidos: exclusivamente MASTER.
      if (url.pathname === "/api/catalogo/productos" && request.method === "POST") {
        const no = denied();
        if (no) return no;

        try {
          const body = await request.json();

          if (!body ||
              !/^[a-zA-Z0-9_-]{1,120}$/.test(String(body.id || "")) ||
              !String(body.nombre || "").trim()) {
            return Response.json({ error: "Ficha de producto no válida." }, { status: 400 });
          }

          const product = {
            ...body,
            id: String(body.id),
            visual_review: "pending",
            updatedAt: new Date().toISOString(),
            updatedBy: user.id
          };

          delete product.docId;
          delete product.fotos;
          delete product.commercialData;

          await kv.put("product:" + product.id, JSON.stringify(product));

          return Response.json(
            { ok: true, id: product.id },
            { headers: noStore }
          );
        } catch (error) {
          return Response.json({ error: "No se pudo guardar el producto compartido." }, { status: 400 });
        }
      }

      // Consultar modelos 3D compartidos.
      if (url.pathname === "/api/catalogo/modelos" && request.method === "GET") {
        try {
          const models = [];
          let cursor;

          do {
            const page = await kv.list({ prefix: "model:", cursor, limit: 1000 });

            const rows = await Promise.all(page.keys.map(async item => {
              const value = await kv.get(item.name);
              if (!value) return null;

              const m = JSON.parse(value);

              return {
                id: m.id,
                name: m.name,
                brand: m.brand,
                ref: m.ref,
                author: m.author,
                source: m.source,
                lic: m.lic,
                cat: m.cat,
                units: m.units,
                ext: m.ext,
                date: m.date
              };
            }));

            models.push(...rows.filter(Boolean));
            cursor = page.list_complete ? undefined : page.cursor;
          } while (cursor);

          return Response.json({ models }, { headers: noStore });
        } catch (error) {
          return Response.json({ error: "No se pudieron cargar los modelos compartidos." }, { status: 502 });
        }
      }

      // Descargar un modelo 3D compartido.
      const modelId = url.pathname.startsWith("/api/catalogo/modelo/")
        ? decodeURIComponent(url.pathname.slice("/api/catalogo/modelo/".length))
        : "";

      if (/^[a-zA-Z0-9_-]{1,120}$/.test(modelId) && request.method === "GET") {
        const value = await kv.get("model:" + modelId);

        return value
          ? new Response(value, {
              headers: {
                ...noStore,
                "Content-Type": "application/json"
              }
            })
          : Response.json({ error: "Modelo no encontrado." }, { status: 404 });
      }

      // Guardar modelos 3D compartidos: exclusivamente MASTER.
      if (url.pathname === "/api/catalogo/modelos" && request.method === "POST") {
        const no = denied();
        if (no) return no;

        try {
          const body = await request.json();

          if (!body ||
              !/^[a-zA-Z0-9_-]{1,120}$/.test(String(body.id || "")) ||
              !["glb", "gltf", "obj"].includes(body.ext) ||
              typeof body.data !== "string" ||
              body.data.length > 23 * 1024 * 1024) {
            return Response.json(
              { error: "Modelo no válido o demasiado grande (máximo aproximado 17 MB)." },
              { status: 413 }
            );
          }

          await kv.put("model:" + body.id, JSON.stringify(body));

          return Response.json(
            { ok: true, id: body.id },
            { headers: noStore }
          );
        } catch (error) {
          return Response.json({ error: "No se pudo compartir el modelo 3D." }, { status: 400 });
        }
      }

      return Response.json(
        { error: "Método o ruta de catálogo no admitidos." },
        { status: 405 }
      );
    }

    // Rutas API inexistentes
    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        { error: "Ruta API no encontrada" },
        { status: 404 }
      );
    }

    const accessPage = url.pathname === "/acceso" || url.pathname === "/acceso.html";
    if (!accessPage) {
      const token = (url.pathname.startsWith("/catalogo/") && request.method === "GET" ? bearer(request) : "") || sessionCookie(request);
      if (!token || !await getSupabaseUser(token).catch(() => null)) {
        return new Response(null, { status: 302, headers: {
          ...NO_STORE, Location: "/acceso" + url.search
        } });
      }
    }
    if (accessPage) url.pathname = "/acceso.html";
    else if (url.pathname === "/" || url.pathname === "/index" || url.pathname === "/editor") url.pathname = "/index.html";
    const asset = await env.ASSETS.fetch(new Request(url, request));
    const headers = new Headers(asset.headers);
    headers.set("Cache-Control", NO_STORE["Cache-Control"]);
    return new Response(asset.body, { status: asset.status, headers });
  }
};
