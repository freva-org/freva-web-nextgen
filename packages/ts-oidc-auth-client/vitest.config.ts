import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "happy-dom",
    // Non-localhost http origin: `localhost` is a trustworthy origin under
    // the modern cookie rules (Secure cookies ARE accepted there, in real
    // browsers and happy-dom >= 20 alike), which would mask the
    // Secure-on-http misconfiguration the cookie probe tests exercise.
    environmentOptions: { happyDOM: { url: "http://app.test/" } },
    include: ["tests/**/*.test.ts"],
  },
});
