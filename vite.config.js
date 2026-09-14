import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 网络盘（UNC/映射盘符）兼容：禁止 realpath——映射盘符会被还原成 UNC 形式，
  // 后续 posix 归一化把 '//server/share' 压成 '/server/share' 导致解析到盘符根目录下而 ENOENT
  resolve: { preserveSymlinks: true },
  server: {
    host: '127.0.0.1',
    port: 8123,
    // NAS 网络盘上 inotify/ReadDirectoryChanges 不可靠，用轮询保证 HMR 生效
    watch: { usePolling: true, interval: 500 },
  },
});
