import { execFileSync } from 'node:child_process';

export default function globalSetup() {
  execFileSync('pnpm', ['seed'], { cwd: process.cwd(), stdio: 'inherit' });
}
