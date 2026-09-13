import express, { type RequestHandler } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { privatePortalHtml } from './applicant-page-security';

interface ManifestChunk { file: string; name?: string; isDynamicEntry?: boolean; imports?: string[]; css?: string[]; }
type BuildManifest = Record<string, ManifestChunk>;
const fingerprinted = /[-.][A-Za-z0-9_-]{8,}\.(?:m?js|css|svg|png|jpe?g|webp|ico|woff2?)$/;

/** Only public, content-addressed build assets receive immutable caching. */
export function publicAssets(publicDir: string): RequestHandler {
  const root = resolve(publicDir);
  const ordinary = express.static(root, {index:false, dotfiles:'deny', setHeaders(res, path) {
    if (fingerprinted.test(path)) res.setHeader('Cache-Control','public, max-age=31536000, immutable');
  }});
  return (req,res,next) => {
    if (!['GET','HEAD'].includes(req.method) || req.headers.range) { ordinary(req,res,next); return; }
    let pathname: string;
    try { pathname = decodeURIComponent(req.path); } catch { ordinary(req,res,next); return; }
    const file = resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}${sep}`) || !fingerprinted.test(file) || !['.js','.mjs','.css','.svg'].includes(extname(file))) { ordinary(req,res,next); return; }
    res.vary('Accept-Encoding');
    const encoding = req.acceptsEncodings('br','gzip','identity');
    const suffix = encoding === 'br' ? '.br' : encoding === 'gzip' ? '.gz' : '';
    if (!suffix || !existsSync(file + suffix)) { ordinary(req,res,next); return; }
    res.type(extname(file));
    res.set('Content-Encoding',encoding as string);
    res.set('Cache-Control','public, max-age=31536000, immutable');
    res.sendFile(file + suffix, {dotfiles:'deny'}, error => { if (error) next(error); });
  };
}

/** Preload the selected route's existing modules without executing extra routes
 * or changing the order in which their styles are applied. */
export function createPageShell(publicDir: string): (url: string) => string {
  const html = readFileSync(resolve(publicDir,'index.html'),'utf8');
  const manifestPath = resolve(publicDir,'.vite/manifest.json');
  const manifest: BuildManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath,'utf8')) : {};
  // Rollup can merge a re-export-only page into a shared dynamic chunk. Its
  // source key then disappears, but the named dynamic entry remains.
  const tenantEntry = manifest['src/pages/tenant-portal.tsx'] ? 'src/pages/tenant-portal.tsx'
    : Object.keys(manifest).find(key => manifest[key].name === 'tenant-portal' && manifest[key].isDynamicEntry);
  const hints = (entries: string[]) => {
    const modules = new Set<string>(); const styles = new Set<string>(); const visited = new Set<string>();
    const visit = (key: string) => {
      if (visited.has(key)) return; visited.add(key);
      const chunk = manifest[key]; if (!chunk) return;
      modules.add(chunk.file); chunk.css?.forEach(file => styles.add(file)); chunk.imports?.forEach(visit);
    };
    entries.forEach(visit);
    const safe = (file: string) => /^[A-Za-z0-9_./-]+$/.test(file) && !file.split('/').includes('..');
    return Array.from(modules).filter(safe).map(file=>`<link rel="modulepreload" crossorigin href="/${file}">`).join('')
      + Array.from(styles).filter(safe).map(file=>`<link rel="preload" as="style" crossorigin href="/${file}">`).join('');
  };
  const variants = {
    ops: hints(['src/components/app-providers.tsx','src/components/ui/toaster.tsx','src/pages/rent-ops.tsx','src/features/rent-ops/workspace/rm-workspace.tsx']),
    classic: hints(['src/components/app-providers.tsx','src/components/ui/toaster.tsx','src/pages/rent-ops.tsx','src/features/rent-ops/rent-ops-workspace.tsx']),
    tenant: hints(tenantEntry ? [tenantEntry] : []),
    apply: hints(['src/pages/rent-ops-apply.tsx']),
  };
  return url => {
    const parsed = new URL(url,'http://local.invalid');
    const extra = /^\/ops(?:\/|$)/.test(parsed.pathname) ? variants[parsed.searchParams.get('ui')==='classic'?'classic':'ops']
      : /^\/tenant(?:\/|$)/.test(parsed.pathname) ? variants.tenant
      : /^\/apply(?:\/|$)/.test(parsed.pathname) ? variants.apply : '';
    return privatePortalHtml(html,url).replace('</head>',`${extra}</head>`);
  };
}
