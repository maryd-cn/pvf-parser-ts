import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import { resolve } from 'path';

const allEntries = [
  { name: 'reactDemo', path: resolve('src/webview/reactDemo.tsx') },
  { name: 'aniPreview', path: resolve('src/webview/aniPreview.tsx') },
  { name: 'apcEditor', path: resolve('src/webview/apcEditor.tsx') },
];
const outdir = resolve('media/webview');
const tmpOutdir = resolve('media/.webview-build-tmp');

const isProd = process.argv.includes('--prod');
const entryArg = process.argv.find(arg => arg.startsWith('--entry='))?.slice('--entry='.length)
  || process.env.PVF_WEBVIEW_ENTRY
  || process.env.WEBVIEW_ENTRY
  || '';
const requestedEntries = entryArg
  ? new Set(entryArg.split(',').map(item => item.trim()).filter(Boolean))
  : undefined;
const entries = requestedEntries
  ? allEntries.filter(entry => requestedEntries.has(entry.name))
  : allEntries;

if (!entries.length) {
  throw new Error(`No webview entry matched: ${Array.from(requestedEntries || []).join(', ')}`);
}

try { rmSync(tmpOutdir, { recursive: true, force: true }); } catch {}
mkdirSync(tmpOutdir, { recursive: true });

const pkgStubPlugin = {
  name: 'pkg-stub',
  setup(b) {
    b.onResolve({ filter: /package\.json$/ }, args => {
      // 若路径指向上一层空 package.json（表现为以 ../package.json 结尾），用 stub 替换
      if (args.path.endsWith('../package.json') || args.path === '../package.json') {
        return { path: 'stub-package-json', namespace: 'pkgstub' };
      }
      return null;
    });
    b.onLoad({ filter: /.*/, namespace: 'pkgstub' }, () => ({
      contents: '{"name":"stub-root","version":"0.0.0"}',
      loader: 'json'
    }));
  }
};

try {
  for (const entry of entries) {
    await build({
      absWorkingDir: resolve('.'),
      entryPoints: [entry.path],
      outfile: resolve(tmpOutdir, `${entry.name}.js`),
      bundle: true,
      minify: isProd,
      sourcemap: !isProd,
      format: 'iife',
      platform: 'browser',
      target: ['es2019'],
      logLevel: 'info',
      external: [],
      mainFields: ['module','main'],
      conditions: ['browser','default'],
      plugins: [pkgStubPlugin],
      define: { 'process.env.NODE_ENV': JSON.stringify(isProd ? 'production' : 'development') },
    });
  }

  if (requestedEntries) {
    mkdirSync(outdir, { recursive: true });
    for (const entry of entries) {
      copyFileSync(resolve(tmpOutdir, `${entry.name}.js`), resolve(outdir, `${entry.name}.js`));
      const sourceMap = resolve(tmpOutdir, `${entry.name}.js.map`);
      if (existsSync(sourceMap)) copyFileSync(sourceMap, resolve(outdir, `${entry.name}.js.map`));
    }
  } else {
    try { rmSync(outdir, { recursive: true, force: true }); } catch {}
    renameSync(tmpOutdir, outdir);
  }
} finally {
  try { rmSync(tmpOutdir, { recursive: true, force: true }); } catch {}
}

console.log(`webview build complete (${entries.map(entry => entry.name).join(', ')})`);
