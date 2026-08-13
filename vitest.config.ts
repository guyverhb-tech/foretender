import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Installs the globalThis.fetch poison — the zero-network backstop.
    // test/network-poison.test.ts fails if this registration is removed.
    setupFiles: ['./test/setup.ts'],
  },
});
