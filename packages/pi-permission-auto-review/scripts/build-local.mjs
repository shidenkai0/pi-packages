// Build this local-only fork with the tools and runtime deps already installed by Pi.
// Does not install packages or read Pi settings/authentication files.
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const piRoot = process.env.AUTO_REVIEW_TEST_PI_ROOT
const packagesRoot = process.env.AUTO_REVIEW_TEST_PACKAGES_ROOT
if (!piRoot || !packagesRoot) throw new Error('Set AUTO_REVIEW_TEST_PI_ROOT and AUTO_REVIEW_TEST_PACKAGES_ROOT')
const readVersion = root => JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
const permissionRoot = resolve(packagesRoot, '@gotgenes/pi-permission-system')
if (readVersion(piRoot) !== '0.85.0' || readVersion(permissionRoot) !== '26.3.1') {
  throw new Error('This local build is verified only with Pi 0.85.0 and permission-system 26.3.1')
}
if (readVersion(resolve(packagesRoot, 'zod')) !== '4.4.3' || readVersion(resolve(packagesRoot, '@mzwing/pi-polyfill')) !== '0.0.1') {
  throw new Error('This local build requires the installed zod 4.4.3 and pi-polyfill 0.0.1 baseline')
}
const { build } = createRequire(resolve(piRoot, 'package.json'))('esbuild')
await build({
  absWorkingDir: packageRoot,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node', format: 'esm', target: 'node24', sourcemap: true,
  external: ['@earendil-works/*'],
  alias: {
    '@gotgenes/pi-permission-system': resolve(permissionRoot, 'src/service.ts'),
    '@mzwing/pi-polyfill': resolve(packagesRoot, '@mzwing/pi-polyfill/dist/index.js'),
    zod: resolve(packagesRoot, 'zod/index.js'),
  },
})
console.log('Built dist/index.js from local source using installed dependencies; no installation or activation performed.')
