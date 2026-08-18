import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// El bundle se escribe directo en el STATICFILES_DIRS de business.
// Nombres fijos (sin hash) para que el template no tenga que leer manifest.json.
// ponytail: sin cache-busting; si el navegador se queda pegado, Ctrl+F5.
export default defineConfig({
  plugins: [react()],
  base: '/static/dashboard/',
  build: {
    outDir: '../business_fud/static/dashboard',
    emptyOutDir: true,
    // El aviso de 500 kB está calibrado para webs públicas en red móvil. Esto
    // lo abren 2 personas en escritorio, mismo origen, y queda cacheado. No hay
    // nada que diferir: todos los paneles se pintan en la primera pantalla.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: { entryFileNames: 'app.js', assetFileNames: 'app.css' },
    },
  },
  server: {
    proxy: { '/admin': 'http://127.0.0.1:8000' },
  },
})
