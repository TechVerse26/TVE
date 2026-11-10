import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Capacitor serves the built files from https://localhost/ inside the app, so absolute paths work (and keep working on nested routes).
export default defineConfig({
  base: "/",
  plugins: [react()],
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 900 },
  server: { port: 5173, host: true },
});
