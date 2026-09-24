import {readdir, readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';

const raster = /\.(?:jpe?g|png|webp)$/i;
async function images(directory) {
  const result=[];
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const file=path.join(directory,entry.name);
    if(entry.isDirectory()) result.push(...await images(file));
    else if(entry.isFile()&&raster.test(entry.name)&&!entry.name.includes('.responsive-v1-')) result.push(file);
  }
  return result;
}

/** Optimize build copies only. Original source photos are never modified. */
export async function optimizePublicImages(publicDir, attachedDir) {
  sharp.cache(false);
  sharp.concurrency(1);
  if(attachedDir) for(const source of await images(attachedDir)) {
    const target=path.join(publicDir,'attached_assets',path.relative(attachedDir,source));
    await mkdir(path.dirname(target),{recursive:true});
    await writeFile(target,await readFile(source));
  }
  let originalBytes=0, optimizedBytes=0, count=0;
  for(const file of await images(publicDir)) {
    const source=await readFile(file);
    const metadata=await sharp(source).metadata();
    if((metadata.pages??1)>1) continue;
    originalBytes+=source.length;
    // Widths are exact so their srcset width descriptors remain truthful.
    for(const width of [480,1600]) {
      const result=await sharp(source).rotate().resize({width}).webp({quality:76,effort:4}).toBuffer();
      await writeFile(`${file}.responsive-v1-${width}.webp`,result);
      optimizedBytes+=result.length;
    }
    // Keep fallback/CSS URLs, but avoid shipping original multi-megapixel files.
    let fallback=sharp(source).rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true});
    if(/\.jpe?g$/i.test(file)) fallback=fallback.jpeg({quality:78,mozjpeg:true});
    else if(/\.png$/i.test(file)) fallback=fallback.png({compressionLevel:9});
    else fallback=fallback.webp({quality:76});
    const bytes=await fallback.toBuffer();
    await writeFile(file,bytes.length<source.length?bytes:source);
    optimizedBytes+=Math.min(bytes.length,source.length);
    count++;
  }
  return {images:count,originalBytes,optimizedBytes};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=process.cwd();
  console.log(JSON.stringify(await optimizePublicImages(path.join(root,'dist/public'),path.join(root,'attached_assets'))));
}
