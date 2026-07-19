import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const daemonPort = process.env.THETAD_PORT ?? '7777';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${daemonPort}`,
        changeOrigin: true,
      },
    },
  },
});
