import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // 网络盘（UNC/映射盘符）兼容：禁止 realpath——映射盘符会被还原成 UNC 形式，
  // 后续 posix 归一化把 '//server/share' 压成 '/server/share' 导致解析到盘符根目录下而 ENOENT
  resolve: {
    preserveSymlinks: true,
    // Arc UI 组件按 shadcn 约定用 @/ 引用
    alias: { '@': path.resolve(root, 'src') },
  },
  // 几何后台线程（core/geom.worker.js）里按需动态加载 manifold-3d 的 WASM，属于代码分割；
  // Worker 默认打包格式 iife 不支持代码分割，改用 ES 模块（创建时已是 { type: 'module' }）
  worker: { format: 'es' },
  build: {
    rollupOptions: {
      input: {
        // 根路径转到 Studio。Studio 是正式界面，redesign 是独立的新界面设计稿（同一套 core）。
        main: path.resolve(root, 'index.html'),
        studio: path.resolve(root, 'studio.html'),
        redesign: path.resolve(root, 'redesign.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 8123,
    // 端口固定：Tauri 桌面壳的 devUrl（tauri.conf.json）指向 8123，漂移了就连不上
    strictPort: true,
    // NAS 网络盘上 inotify/ReadDirectoryChanges 不可靠，用轮询保证 HMR 生效
    watch: { usePolling: true, interval: 500 },
  },
});
