import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: "esnext",
    assetsInlineLimit: Infinity,
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        pod_resource_monitor: "src/pod_resource_monitor/index.html",
      },
    },
  },
});
