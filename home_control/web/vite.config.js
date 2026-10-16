import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import prefixer from 'postcss-prefix-selector';

// Heating and lighting were separate apps and share class names (.app, .top, .tabs, .btn, .sheet…)
// with slightly different looks. Each half's stylesheet is scoped to its own section at build time,
// so each looks exactly as it did on its own: body.sec-heating … / body.sec-lighting ….
function scopeTo(section, dir) {
  const prefix = `body.sec-${section}`;
  return prefixer({
    prefix,
    includeFiles: [new RegExp(`[\\\\/]src[\\\\/]${dir}[\\\\/][^\\\\/]+\\.css$`)],
    transform(pre, selector, prefixed) {
      const s = selector.trim();
      if (s === ':root' || s === 'html' || s === 'body') return prefix;
      if (s.startsWith('body.') || s.startsWith('body:')) return prefix + s.slice(4);
      if (s.startsWith('html ')) return `${prefix} ${s.slice(5)}`;
      if (s.startsWith('body ')) return `${prefix} ${s.slice(5)}`;
      return prefixed;
    },
  });
}

// base './' so every asset URL is relative — required behind HA ingress.
export default defineConfig({
  base: './',
  plugins: [react()],
  css: { postcss: { plugins: [scopeTo('heating', 'heating'), scopeTo('lighting', 'lighting'), scopeTo('cameras', 'cameras')] } },
  server: { proxy: { '/api': 'http://localhost:8099' } },
  build: { outDir: 'dist', emptyOutDir: true },
});
