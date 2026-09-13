import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { createPageShell, publicAssets } from './static-assets';

test('public asset compression preserves bytes, content type, HEAD and range behavior',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rent-ops-assets-')); mkdirSync(join(dir,'assets'));
  const content='export const example = "synthetic fixture";\n'.repeat(500);
  const name='assets/example-abcdefgh.js';writeFileSync(join(dir,name),content);
  writeFileSync(join(dir,name+'.br'),brotliCompressSync(content));writeFileSync(join(dir,name+'.gz'),gzipSync(content));
  writeFileSync(join(dir,'.env'),'must remain private');
  const app=express();app.use(publicAssets(dir));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try{
    for(const [accept,encoding] of [['br,gzip','br'],['gzip','gzip'],['br;q=0,gzip;q=0,identity',''],['identity','']]){
      const r=await fetch(`${origin}/${name}`,{headers:{'accept-encoding':accept}});
      assert.equal(r.status,200);assert.equal(r.headers.get('content-encoding')??'',encoding);
      assert.match(r.headers.get('content-type')!,/javascript/);
      assert.match(r.headers.get('cache-control')!,/immutable/);assert.match(r.headers.get('vary')!,/Accept-Encoding/);
      assert.equal(await r.text(),content);
    }
    const head=await fetch(`${origin}/${name}`,{method:'HEAD',headers:{'accept-encoding':'br'}});
    assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(head.headers.get('content-encoding'),'br');
    const range=await fetch(`${origin}/${name}`,{headers:{range:'bytes=0-9','accept-encoding':'br'}});
    assert.equal(range.status,206);assert.equal(range.headers.get('content-encoding'),null);assert.equal(await range.text(),content.slice(0,10));
    assert.equal((await fetch(`${origin}/.env`)).status,404);
    assert.equal((await fetch(`${origin}/${name}`,{method:'POST'})).status,404);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});}
});

test('page hints preload only selected route modules and leave style application order intact',()=>{
  const dir=mkdtempSync(join(tmpdir(),'rent-ops-shell-'));mkdirSync(join(dir,'.vite'));
  writeFileSync(join(dir,'index.html'),'<html><head><title>Original</title><link rel="stylesheet" href="/assets/base-abcdefgh.css"><link rel="stylesheet" href="https://fonts.example.test/style"></head><body>Same UI</body></html>');
  writeFileSync(join(dir,'.vite/manifest.json'),JSON.stringify({
    'src/pages/rent-ops.tsx':{file:'assets/ops-abcdefgh.js'},
    'src/features/rent-ops/workspace/rm-workspace.tsx':{file:'assets/workspace-abcdefgh.js',imports:['shared'],css:['assets/workspace-abcdefgh.css']},
    'src/features/rent-ops/rent-ops-workspace.tsx':{file:'assets/classic-abcdefgh.js'},
    'src/pages/tenant-portal.tsx':{file:'assets/tenant-abcdefgh.js'},
    'src/pages/rent-ops-apply.tsx':{file:'assets/apply-abcdefgh.js'},
    shared:{file:'assets/shared-abcdefgh.js'},
  }));
  try{
    const shell=createPageShell(dir);const ops=shell('/ops?section=tenants');
    assert.match(ops,/modulepreload[^>]+workspace-abcdefgh.js/);assert.match(ops,/modulepreload[^>]+shared-abcdefgh.js/);
    assert.match(ops,/preload" as="style"[^>]+workspace-abcdefgh.css/);assert.doesNotMatch(ops,/stylesheet[^>]+workspace-abcdefgh.css/);
    assert.doesNotMatch(ops,/classic-abcdefgh.js|tenant-abcdefgh.js|apply-abcdefgh.js/);
    assert.match(shell('/ops?ui=classic'),/classic-abcdefgh.js/);assert.doesNotMatch(shell('/ops?ui=classic'),/workspace-abcdefgh.js/);
    assert.doesNotMatch(shell('/tenant'),/fonts.example.test|workspace-abcdefgh/);assert.match(shell('/tenant'),/tenant-abcdefgh.js/);
    assert.match(shell('/apply/property'),/apply-abcdefgh.js/);assert.match(shell('/'),/Same UI/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
