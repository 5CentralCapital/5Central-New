import type { RequestHandler } from 'express';

/** Local benchmark transport: cold responses, 80 ms latency and one shared
 * 10 Mbit/s download budget. This module is never imported by the app server. */
export function performanceNetwork(): RequestHandler {
  const queue: Array<{body:Buffer;offset:number;write:(bytes:Buffer)=>void;end:()=>void;closed:()=>boolean}> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pump = () => {
    timer=undefined;let remaining=12500;
    while(queue.length&&remaining>0) {
      const item=queue.shift()!;
      if(item.closed())continue;
      const length=Math.min(remaining,item.body.length-item.offset,4096);
      if(length){item.write(item.body.subarray(item.offset,item.offset+length));item.offset+=length;remaining-=length;}
      if(item.offset===item.body.length)item.end();else queue.push(item);
    }
    if(queue.length)timer=setTimeout(pump,10);
  };
  return (req,res,next) => {
    delete req.headers['if-none-match'];delete req.headers['if-modified-since'];
    const setHeader=res.setHeader.bind(res);
    res.setHeader=((name:string,value:any)=>setHeader(name,name.toLowerCase()==='cache-control'?'no-store':value)) as any;
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Performance-Network','80ms;10000000bps;shared;no-store');
    const chunks:Buffer[]=[];const write=res.write.bind(res),end=res.end.bind(res);
    let closed=false;res.on('close',()=>{closed=true;});
    res.write=((chunk:any,encoding:any,callback:any)=>{chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,typeof encoding==='string'?encoding:undefined));(typeof encoding==='function'?encoding:callback)?.();return true;}) as any;
    res.end=((chunk?:any,encoding?:any,callback?:any)=>{
      if(chunk&&typeof chunk!=='function')chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,typeof encoding==='string'?encoding:undefined));
      const done=typeof chunk==='function'?chunk:typeof encoding==='function'?encoding:callback;
      setTimeout(()=>{queue.push({body:Buffer.concat(chunks),offset:0,write:bytes=>write(bytes),end:()=>end(done),closed:()=>closed});if(!timer)pump();},80);
      return res;
    }) as any;
    next();
  };
}
