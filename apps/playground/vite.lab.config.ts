import { fileURLToPath } from 'node:url';
import { loadEnv, mergeConfig } from 'vite';
import { tracepilotSourceMaps } from '@trace-pilot/vite-plugin';
import lab from './lab.json';
import base from './vite.config';

/**
 * 生产演练（pnpm lab:production）的构建配置：在 vite.config.ts 之上加 TracePilot 的构建插件，
 * 给产物注入 Debug ID，把 Source Map 上传到演练场上报的那个项目和版本，map 不进入 dist。
 *
 * 单独一个文件而不是在 vite.config.ts 里按 mode 判断：Vite 加载配置时会解析其中的每个 import
 * （包括动态 import），而插件包要先构建才有可加载的入口。lab:production 会先构建依赖，pnpm dev 不会。
 */
// 与构建读取同一份 .env：上传到的项目，就是构建出的演练场上报的项目。
const env = loadEnv('production', fileURLToPath(new URL('.', import.meta.url)), 'VITE_');

export default mergeConfig(base, {
  plugins: [
    tracepilotSourceMaps({
      url: env.VITE_API_URL ?? 'http://localhost:4318',
      projectId: env.VITE_DEMO_PROJECT_ID ?? 'demo-project',
      // 与 src/lab.ts 同源：SDK 上报的版本号就是上传 map 的版本号。
      release: lab.release,
    }),
  ],
});
