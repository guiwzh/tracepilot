import { execFileSync } from 'node:child_process';

// 每轮 E2E 前重建确定性演示数据，断言不依赖开发者本机上一次操作留下的状态。
export default function globalSetup() {
  execFileSync('pnpm', ['seed'], { cwd: process.cwd(), stdio: 'inherit' });
}
