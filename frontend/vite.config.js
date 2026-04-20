import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        proxy: {
            '/etl': { target: 'http://localhost:8000', changeOrigin: true },
            '/transform': { target: 'http://localhost:8000', changeOrigin: true },
            '/data': { target: 'http://localhost:8000', changeOrigin: true },
            '/services': { target: 'http://localhost:8000', changeOrigin: true },
            '/dictionaries': { target: 'http://localhost:8000', changeOrigin: true },
            '/connections': { target: 'http://localhost:8000', changeOrigin: true },
        },
    },
});
