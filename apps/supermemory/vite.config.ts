import { cloudflare } from "@cloudflare/vite-plugin"
import { reactRouter } from "@react-router/dev/vite"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import tsconfigPaths from "vite-tsconfig-paths"

export default defineConfig({
    server: {
        port: 5174,
    },
    plugins: [
        cloudflare({
            viteEnvironment: { name: "ssr" },
        }),
        tailwindcss(),
        reactRouter(),
        tsconfigPaths(),
    ],
    optimizeDeps: {
        exclude: [
            "@standard-community/standard-json",
            "@valibot/to-json-schema",
            "valibot",
        ],
    },
    ssr: {
        noExternal: true,
    },
})
