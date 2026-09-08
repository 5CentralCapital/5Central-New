import { useEffect, useRef, useState } from 'react';
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { fetchLeasePdf, leasePdfPath } from './lease-pdf';
import { TenantApiError } from './api';
GlobalWorkerOptions.workerSrc=workerUrl;

export function LeaseViewer({id,fileName,onClose,onError}:{id:string;fileName:string;onClose:()=>void;onError:(error:unknown)=>void}) {
 const [pdf,setPdf]=useState<PDFDocumentProxy>();const [page,setPage]=useState(1);const [zoom,setZoom]=useState(1);const [busy,setBusy]=useState(true);const [error,setError]=useState('');const [text,setText]=useState('');
 const canvas=useRef<HTMLCanvasElement>(null);const heading=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{
  const abort=new AbortController();let disposed=false;let loading:ReturnType<typeof getDocument>|undefined;
  heading.current?.focus();
  void fetchLeasePdf(id,abort.signal).then(bytes=>{
   if(disposed)return;
   // No document scripts, XFA, external resource URLs, or annotation actions.
   // PDF.js 6 removed eval support; retain the explicit opt-out for compatible versions.
   const options={data:bytes,isEvalSupported:false,enableXfa:false,useWasm:false,disableFontFace:true,useSystemFonts:true};
   loading=getDocument(options);return loading.promise;
  }).then(document=>{if(document&&!disposed)setPdf(document);}).catch(caught=>{if(!disposed){setBusy(false);setError(caught instanceof Error?caught.message:'Unable to open this lease.');if(caught instanceof TenantApiError)onError(caught);}});
  return()=>{disposed=true;abort.abort();void loading?.destroy();};
 },[id]);
 useEffect(()=>{
  if(!pdf||!canvas.current)return;let disposed=false;let render:RenderTask|undefined;setBusy(true);setText('');setError('');
  void pdf.getPage(page).then(async documentPage=>{
   if(disposed||!canvas.current)return;
   const viewport=documentPage.getViewport({scale:zoom});const target=canvas.current;const ratio=Math.min(window.devicePixelRatio||1,2);
   target.style.width=`${viewport.width}px`;target.style.height=`${viewport.height}px`;
   target.width=Math.ceil(viewport.width*ratio);target.height=Math.ceil(viewport.height*ratio);
   render=documentPage.render({canvas:target,viewport,transform:ratio===1?undefined:[ratio,0,0,ratio,0,0]});
   await render.promise;
   const content=await documentPage.getTextContent();
   if(!disposed){setText(content.items.map(item=>'str'in item?item.str:'').join(' '));setBusy(false);}
  }).catch(caught=>{if(!disposed){setBusy(false);setError('This page could not be rendered. Download the original PDF or contact management.');}});
  return()=>{disposed=true;render?.cancel();};
 },[pdf,page,zoom]);
 return <section className="tp-pdf-viewer" aria-labelledby="tp-pdf-heading"><div className="tp-pdf-toolbar"><h3 id="tp-pdf-heading" ref={heading} tabIndex={-1}>{fileName}</h3><button type="button" className="tp-secondary" onClick={onClose}>Close preview</button></div><div className="tp-pdf-toolbar"><button type="button" className="tp-secondary" disabled={!pdf||page<=1||busy} onClick={()=>setPage(page-1)}>Previous page</button><span role="status">Page {page} of {pdf?.numPages??'…'}</span><button type="button" className="tp-secondary" disabled={!pdf||page>=pdf.numPages||busy} onClick={()=>setPage(page+1)}>Next page</button><label>Zoom <select value={zoom} onChange={event=>setZoom(Number(event.target.value))}><option value={0.75}>75%</option><option value={1}>100%</option><option value={1.5}>150%</option><option value={2}>200%</option></select></label><a className="tp-secondary" href={leasePdfPath(id)}>Download PDF</a></div>{busy&&<p role="status">Rendering lease…</p>}{error&&<p role="alert" className="tp-error">{error}</p>}<div className="tp-pdf-page" aria-busy={busy}><canvas ref={canvas} role="img" aria-label={`Lease page ${page}`} /></div>{text&&<details><summary>Page {page} text</summary><p className="tp-pdf-text">{text}</p></details>}</section>;
}
