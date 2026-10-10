import base44 from '@base44/vite-plugin';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [base44()],
  // The design model, edit history and XML code are shared with the Node server (../server/src).
  server: { fs: { allow: ['..'] } },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        design: resolve(import.meta.dirname, 'design.html'),
      },
    },
  },
});
