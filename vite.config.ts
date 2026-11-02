import { defineConfig } from "vite";
import webExtension, { readJsonFile } from "vite-plugin-web-extension";

const target = process.env.TARGET === "firefox" ? "firefox": "chrome";

export default defineConfig({
  plugins: [webExtension({
    
      browser: target,
      webExtConfig: {
        "target": target === "firefox" ? "firefox-desktop" : "chromium",
        "startUrl": "https://www.youtube.com/"
      },
      manifest: () => {
        const pkg = readJsonFile("package.json");
        const template = readJsonFile(`manifest.${target}.json`);
        return {
          ...template,
          version: pkg.version,
        };
      },
  })],
  build: {
    outDir: `dist/${target}`,
    emptyOutDir: true, // Limpia la carpeta antes de cada build
  },
});