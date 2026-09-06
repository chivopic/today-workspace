import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["icon.svg", "icon-192.png", "icon-512.png"],
      manifest: {
        id: "./",
        name: "Today — Mobile Workspace",
        short_name: "Today",
        description: "一个克制、本地优先的移动端记录与任务工作台",
        start_url: "./",
        scope: "./",
        display: "standalone",
        background_color: "#f7f7f5",
        theme_color: "#f7f7f5",
        lang: "zh-CN",
        categories: ["productivity", "utilities"],
        prefer_related_applications: false,
        icons: [
          {
            src: "icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any"
          },
          {
            src: "icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable"
          },
          {
            src: "icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any"
          }
        ]
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png}"],
        cleanupOutdatedCaches: true,
        navigateFallback: "index.html"
      }
    })
  ]
});
