import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    fs: {
      // allow importing from the ../shared/ directory (monorepo root)
      allow: ['..'],
    },
  },
});
