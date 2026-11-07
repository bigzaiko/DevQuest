import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The React challenge sandbox needs React's DEVELOPMENT build: tests use act(), which production
// React does not ship. It is built as its own bundle so the main site keeps the fast production React.
export default defineConfig({
  base: './',
  mode: 'development',
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('development') },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { sandbox: 'sandbox.html' }, output: { entryFileNames: 'sandbox/[name]-[hash].js', chunkFileNames: 'sandbox/[name]-[hash].js', assetFileNames: 'sandbox/[name]-[hash][extname]' } },
  },
})
