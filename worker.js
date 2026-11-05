
const SUPABASE_URL = "https://aqfqwvzbsbjrixzgxtro.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxZnF3dnpic2Jqcml4emd4dHJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM1NTA5MjMsImV4cCI6MjEwOTEyNjkyM30.VWRIowVOECv7ycW3Nnpz-EQNJx2izM7yx7xOxkNWVZo";
const FOTO_IA_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";

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

    // Estadísticas personales de Foto IA (día natural de España).
    if (url.pathname === "/api/ia/estadisticas") {
      if (request.method !== "GET") return Response.json({ error: "Utiliza GET." }, { status: 405 });
      try {
        const rawToken = (request.headers.get("Authorization") || "").replace(/^Bearer\\s+/i, "").trim();
        const deviceId = request.headers.get("X-FotoIA-Device") || "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
          return Response.json({ error: "No se ha podido identificar este dispositivo. Recarga la aplicación." }, { status: 400 });
        }
        let user = null;
        if (rawToken) {
          user = await getSupabaseUser(rawToken);
          if (!user) return Response.json({ error: "La sesión ha caducado. Vuelve a entrar en «Mis proyectos»." }, { status: 401 });
        }
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
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\\s+/i, "").trim();
        deviceId = request.headers.get("X-FotoIA-Device") || "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
          return Response.json({ error: "No se ha podido identificar este dispositivo. Recarga la aplicación." }, { status: 400 });
        }
        let user = null;
        if (token) {
          user = await getSupabaseUser(token);
          if (!user) return Response.json({ error: "La sesión ha caducado. Vuelve a entrar en «Mis proyectos»." }, { status: 401 });
        }
        if (!env.AI) return Response.json({ error: "Workers AI no está disponible." }, { status: 503 });

        const received = await request.formData();
        const image = received.get("imagen");
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

        const aiForm = new FormData();
        aiForm.append("prompt", "Transform this exact interior design screenshot into a highly photorealistic architectural interior photograph. " + fidelityInstruction + " Never add, remove, move or redesign objects. Do not invent handles, countertops, shelves, decorations or architectural features that are not clearly present in the reference image. Maintain the original camera viewpoint and perspective.");
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
