import type {ImgHTMLAttributes} from 'react';

/** Responsive build derivatives; originals remain available in local development. */
export default function MarketingImage({src,loading='lazy',decoding='async',sizes='(max-width: 640px) 100vw, (max-width: 1100px) 50vw, 33vw',...props}:ImgHTMLAttributes<HTMLImageElement>) {
  const optimized=import.meta.env.PROD&&typeof src==='string'&&src.startsWith('/')&&/\.(?:jpe?g|png|webp)$/i.test(src);
  const source=optimized?src.split('/').map(part=>encodeURIComponent(decodeURIComponent(part))).join('/'):src;
  return <img {...props} src={optimized?`${source}.responsive-v1-1600.webp`:src}
    srcSet={optimized?`${source}.responsive-v1-480.webp 480w, ${source}.responsive-v1-1600.webp 1600w`:props.srcSet}
    sizes={sizes} loading={loading} decoding={decoding}/>;
}
