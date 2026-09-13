// Test-host instrumentation only; never part of the published application.
(() => {
  let pending = 0;
  let frame = 0;
  let candidate = false;
  const original = window.fetch;
  window.fetch = function (...args) {
    pending++;
    return original.apply(this, args).finally(() => { pending--; schedule(); });
  };
  window.__performanceAudit = { ready: 0 };
  function ready() {
    const root = document.getElementById('root');
    const text = root?.innerText ?? '';
    if (document.querySelector('.rm-report-workspace') && !document.querySelector('.rm-report-table-scroll') && !document.querySelector('[role=alert]')) return false;
    return !!document.querySelector('.rm-body,.ro-workspace,.tp-root,.apply-shell,.ro-app') && text.trim()
      && !pending && !/Loading (the workspace|portfolio|tenant|records|the selected report|current charge)|Opening Rent Operations|Opening your account|Loading your home|Opening your application|Signing in…/.test(text);
  }
  function schedule() {
    if (window.__performanceAudit.ready) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!ready()) { candidate = false; schedule(); return; }
      if (!candidate) { candidate = true; schedule(); return; }
      window.__performanceAudit = {
        ready: performance.now(), visible: document.visibilityState,
        text: document.getElementById('root').innerText,
        alerts: [...document.querySelectorAll('[role=alert]')].map(el => el.innerText),
        requests: performance.getEntriesByType('resource').filter(e => e.name.startsWith(location.origin)).map(e => ({path:new URL(e.name).pathname,start:e.startTime,ms:e.duration,bytes:e.encodedBodySize,decoded:e.decodedBodySize})),
      };
      const result = window.__performanceAudit;
      crypto.subtle.digest('SHA-256', new TextEncoder().encode(result.text)).then(hash => {
        const record={...result,text:undefined,path:location.pathname+location.search,textHash:Array.from(new Uint8Array(hash)).map(byte=>byte.toString(16).padStart(2,'0')).join('')};
        document.documentElement.setAttribute('data-performance-audit',JSON.stringify(record));
        original.call(window,'/performance-result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(record),keepalive:true}).catch(()=>{});
      });
    });
  }
  new MutationObserver(schedule).observe(document, {childList:true,subtree:true});
  window.addEventListener('load', schedule);
  schedule();
})();
