import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // shadcn's generator writes `@/…` imports. Defining the same alias in Vite
    // and tsconfig keeps generated components executable and type-safe without
    // a second path-resolution plugin.
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // Use the same host name as Fastify's public callback URL. A login begins
    // through this development proxy, so changing only one side to an IP
    // literal would place the one-time cookie on a different browser host.
    host: "localhost",
    port: 5173,
    proxy: {
      /**
       * Development keeps browser requests same-origin at `/api`. Vite removes
       * that routing prefix and forwards to Fastify over the same loopback
       * hostname used by the browser-visible callback. Production gives the
       * same job to Caddy, so neither environment needs permissive credentialed
       * CORS merely to carry an HttpOnly session cookie.
       */
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/u, ""),
      },
    },
  },
});
