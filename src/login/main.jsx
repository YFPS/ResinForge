import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/inter';
import '@/components/arc/foundation.css';
import LoginApp from './LoginApp.jsx';

createRoot(document.getElementById('root')).render(<LoginApp />);
