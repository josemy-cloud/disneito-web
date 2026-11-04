
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

    // Edición de una habitación usando una imagen de referencia
    if (url.pathname === "/api/ia/editar") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "Utiliza POST." },
          { status: 405 }
        );
      }

      try {
        if (!env.AI) {
          return Response.json(
            { error: "Workers AI no está disponible." },
            { status: 503 }
          );
        }

        const received = await request.formData();
        const image = received.get("imagen");

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
          "Transform this exact interior design screenshot into a highly photorealistic architectural interior photograph. Preserve the original room geometry, camera viewpoint, perspective, layout, furniture positions, proportions, doors, windows, kitchen cabinets and appliances. Do not add, remove, move or redesign objects. Improve only realistic materials, textures, lighting, shadows and reflections. Maintain the original architectural design faithfully."
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

        return new Response(binary, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": "no-store"
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
