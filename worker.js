
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Comprobación del backend
    if (url.pathname === "/api/estado") {
      return Response.json(
        {
          ok: true,
          servicio: "backend-pruebas",
          ia: "pendiente",
          mensaje: "El backend funciona correctamente."
        },
        {
          headers: {
            "Cache-Control": "no-store"
          }
        }
      );
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
