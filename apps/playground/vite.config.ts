import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Playground 只需要标准 React/Vite 转换，不配置额外分包策略。
export default defineConfig({ plugins: [react()] });
