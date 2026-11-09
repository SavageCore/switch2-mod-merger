import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

function gitHash(args) {
  try {
    return execSync(`git rev-parse ${args}`, { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  define: {
    __COMMIT_SHORT__: JSON.stringify(gitHash('--short HEAD')),
    __COMMIT_FULL__: JSON.stringify(gitHash('HEAD')),
  },
});
