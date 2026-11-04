
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
      if (request.method !== "GET") {
        return Response.json({ error: "Utiliza GET." }, { status: 405 });
      }
      try {
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
        if (!token) return Response.json({ error: "Inicia sesión en «Mis proyectos» para consultar el contador." }, { status: 401 });
        const user = await getSupabaseUser(token);
        if (!user) return Response.json({ error: "La sesión ha caducado. Vuelve a entrar en «Mis proyectos»." }, { status: 401 });
        const day = madridDayBounds();
        const [hoy, total] = await Promise.all([
          countFotoIARows(token, user.id, day.start, day.end),
          countFotoIARows(token, user.id)
        ]);
        return Response.json({ ok: true, hoy, total, fecha: day.date, zonaHoraria: "Europe/Madrid" }, {
          headers: { "Cache-Control": "no-store" }
        });
      } catch (error) {
        return Response.json({ error: "No se pudieron cargar las estadísticas.", detalle: String(error.message || error) }, { status: 502 });
      }
    }

    // Edición de una habitación usando una imagen de referencia
    if (url.pathname === "/api/ia/editar") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "Utiliza POST." },
          { status: 405 }
        );
      }

      try {
        const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
        if (!token) {
          return Response.json({ error: "Inicia sesión en «Mis proyectos» para usar Foto IA." }, { status: 401 });
        }
        const user = await getSupabaseUser(token);
        if (!user) {
          return Response.json({ error: "La sesión ha caducado. Vuelve a entrar en «Mis proyectos»." }, { status: 401 });
        }

        if (!env.AI) {
          return Response.json(
            { error: "Workers AI no está disponible." },
            { status: 503 }
          );
        }

        const received = await request.formData();
        const image = received.get("imagen");
        const rawLevel = Number(received.get("nivel"));
        const fidelity = Number.isFinite(rawLevel)
          ? Math.max(0, Math.min(100, rawLevel))
          : 65;
        const fidelityInstruction = fidelity < 34
          ? "Allow stronger photographic interpretation of lighting and surface appearance, but do not change the room layout, architecture, object count or object positions."
          : fidelity < 67
            ? "Balance photorealism with design fidelity. Preserve the exact room layout, architecture, object count, furniture positions and proportions; improve only materials, textures, lighting, shadows and reflections."
            : "Prioritize strict design fidelity over creative interpretation. Preserve the exact geometry, architecture, object count, furniture positions, dimensions, cabinet fronts, handles (only if present), worktops (only if present), doors, windows and camera viewpoint. Do not invent or add any object or detail.";

        if (!image || typeof image === "string") {
          return Response.json(
            { error: "No se ha recibido ninguna imagen." },
            { status: 400 }
          );
        }

        if (!image.type.startsWith("image/")) {
          return Response.json(
            { error: "El archivo no es una imagen." },
            { status: 400 }
          );
        }

        if (image.size > 5 * 1024 * 1024) {
          return Response.json(
            { error: "La imagen supera el límite de 5 MB." },
            { status: 413 }
          );
        }

        const aiForm = new FormData();

        aiForm.append(
          "prompt",
          "Transform this exact interior design screenshot into a highly photorealistic architectural interior photograph. " + fidelityInstruction + " Never add, remove, move or redesign objects. Do not invent handles, countertops, shelves, decorations or architectural features that are not clearly present in the reference image. Maintain the original camera viewpoint and perspective."
        );

        aiForm.append("input_image_0", image, "referencia.png");
        aiForm.append("width", "1024");
        aiForm.append("height", "768");

        const serialized = new Response(aiForm);

        const result = await env.AI.run(
          "@cf/black-forest-labs/flux-2-klein-4b",
          {
            multipart: {
              body: serialized.body,
              contentType: serialized.headers.get("content-type")
            }
          }
        );

        if (!result || !result.image) {
          throw new Error("El modelo no ha devuelto una imagen.");
        }

        const binary = Uint8Array.from(
          atob(result.image),
          c => c.charCodeAt(0)
        );

        // Registrar la generación con el token del usuario: RLS impide escribir en cuentas ajenas.
        let countSynced = true;
        try {
          const saved = await fetch(SUPABASE_URL + "/rest/v1/foto_ia_generaciones", {
            method: "POST",
            headers: {
              apikey: SUPABASE_ANON_KEY,
              Authorization: "Bearer " + token,
              "Content-Type": "application/json",
              Prefer: "return=minimal"
            },
            body: JSON.stringify({ user_id: user.id, modelo: FOTO_IA_MODEL })
          });
          if (!saved.ok) countSynced = false;
        } catch (e) {
          countSynced = false;
        }

        return new Response(binary, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "no-store",
            "X-FotoIA-Count-Synced": countSynced ? "true" : "false"
          }
        });

      } catch (error) {
        return Response.json({
          error: "Error al editar la habitación.",
          detalle: String(error.message || error)
        }, { status: 500 });
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
