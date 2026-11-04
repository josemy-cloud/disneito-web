
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Comprobación del backend
    if (url.pathname === "/api/estado") {
      return Response.json(
        {
          ok: true,
          servicio: "backend-pruebas",
          ia: env.AI ? "disponible" : "no configurada",
          mensaje: "El backend funciona correctamente."
        },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    // Prueba de generación con Workers AI
    if (url.pathname === "/api/ia/prueba") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "Utiliza el método POST." },
          { status: 405 }
        );
      }

      if (!env.AI) {
        return Response.json(
          { error: "Workers AI no está disponible." },
          { status: 503 }
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

        if (!result || !result.image) {
          return Response.json(
            { error: "El modelo no ha devuelto ninguna imagen." },
            { status: 502 }
          );
        }

        const binary = Uint8Array.from(
          atob(result.image),
          character => character.charCodeAt(0)
        );

        return new Response(binary, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "no-store"
          }
        });

      } catch (error) {
        return Response.json(
          {
            error: "Error al ejecutar Workers AI.",
            detalle: String(error.message || error)
          },
          { status: 500 }
        );
      }
    }

    // Rutas API inexistentes
    if (url.pathname.startsWith("/api/")) {
      return Response.json(
        { error: "Ruta API no encontrada" },
        { status: 404 }
      );
    }

    // Servir la aplicación original
    return env.ASSETS.fetch(request);
  }
};
