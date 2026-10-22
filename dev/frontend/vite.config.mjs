import {defineConfig} from 'vite';

export default defineConfig({
  root: '/app/src',
  plugins: [{
    name: 'mindsync-admin-development',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const path = request.url?.split('?')[0];
        if (['/', '/admin', '/admin/'].includes(path)) request.url = '/admin/index.html';
        next();
      });
    },
    handleHotUpdate({file, server}) {
      if (file.endsWith('/app.js')) {
        server.ws.send({type: 'full-reload'});
        return [];
      }
    },
  }],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    headers: {'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer'},
    proxy: {
      '/v1': {target: 'http://backend:8080'},
      '/health': {target: 'http://backend:8080'},
    },
  },
});
