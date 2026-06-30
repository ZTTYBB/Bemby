import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    allowedHosts: true,
    hmr: {
      // Prevent mobile network idle-timeout from triggering full page reloads.
      // Mobile NAT gateways often kill idle WebSocket connections after ~30-60s;
      // increasing the client timeout here gives the HMR socket time to reconnect
      // without immediately falling back to a hard reload.
      timeout: 120000,
    },
    proxy: {
      "/api": {
        target: `http://${process.env.BACKEND_HOST ?? "localhost"}:${process.env.BACKEND_PORT ?? 3000}`,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://${process.env.BACKEND_HOST ?? "localhost"}:${process.env.BACKEND_PORT ?? 3000}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
