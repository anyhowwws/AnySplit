/**
 * Bundles both handlers into single-file ESM Lambda entrypoints.
 *
 * The AWS SDK is bundled rather than externalised: the Lambda Node 22 runtime
 * ships SDK v3, but pinning our own version means no surprise breakage when AWS
 * rolls the runtime. It costs ~2MB of zip, which is free at this scale.
 */
import { build } from 'esbuild';
import { rm, mkdir } from 'node:fs/promises';

const outdir = 'dist';

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

for (const name of ['api', 'parser']) {
  await build({
    entryPoints: [`src/handlers/${name}.ts`],
    outfile: `${outdir}/${name}/index.mjs`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    minify: false, // keeps CloudWatch stack traces readable; size is not a concern
    // esbuild emits ESM that references these CJS builtins via banner shims.
    banner: {
      js: [
        "import { createRequire as __createRequire } from 'node:module';",
        'const require = __createRequire(import.meta.url);',
      ].join('\n'),
    },
    logLevel: 'info',
  });
}

console.log(`built ${outdir}/api/index.mjs and ${outdir}/parser/index.mjs`);
