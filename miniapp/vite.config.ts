import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Declared here rather than by adding @types/node to the app: this config runs
 * in Node, but the application code does not, and pulling in the Node types
 * would wrongly offer `process` to browser modules.
 */
declare const process: { env: Record<string, string | undefined> };

export default defineConfig(({ command }) => {
  /*
   * Fail the build rather than ship a bundle with no API address.
   *
   * VITE_API_BASE is normally supplied by command substitution from a Terraform
   * output. When that substitution fails — expired AWS session, most likely —
   * the shell quietly passes an empty string, `API_BASE` falls back to
   * same-origin, and every API call lands on CloudFront instead. CloudFront's
   * SPA rewrite answers 200 with index.html, so nothing looks broken until a
   * user watches the app fail to load their bill.
   *
   * Cheaper to stop here than to debug it from the far end again.
   */
  if (command === 'build' && !process.env['VITE_API_BASE']) {
    throw new Error(
      'VITE_API_BASE is empty. Build with:\n' +
        '  VITE_API_BASE="$(AWS_PROFILE=terraform terraform -chdir=../infra output -raw api_base_url)" npm run build\n' +
        'If that substitution produced nothing, your AWS session has probably expired — run `aws login`.',
    );
  }

  return {
  plugins: [react(), tailwindcss()],
  build: {
    // Static build, no SSR. Deployed to S3 behind CloudFront.
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    // The dev server is only useful through a tunnel — Telegram requires HTTPS.
    port: 5173,
  },
  };
});
