import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/inter';
import '@/components/arc/foundation.css';
import './library-demo.css';
import './arc-c.css';
import LibraryDemo from './LibraryDemo.jsx';

/* Demo 跟 Studio 共用主题 / 强调色存储；默认深色 + 蓝色 */
try {
  const mode = localStorage.getItem('resinforge:theme') || 'dark';
  const dark = mode === 'system' ? matchMedia('(prefers-color-scheme: dark)').matches : mode === 'dark';
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-accent', localStorage.getItem('resinforge:accent') || 'blue');
} catch {
  document.documentElement.setAttribute('data-theme', 'dark');
  document.documentElement.setAttribute('data-accent', 'blue');
}

createRoot(document.getElementById('root')).render(<LibraryDemo />);
