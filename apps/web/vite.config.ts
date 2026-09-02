import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      /**
       * Development keeps browser requests same-origin at `/api`. Vite removes
       * that routing prefix and forwards to Fastify. Production will give the
       * same job to Caddy, so neither environment needs permissive credentialed
       * CORS merely to carry an HttpOnly session cookie.
       */
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/u, ""),
      },
    },
  },
});
