import { lazy, Suspense } from 'react';
const ClassicWorkspace=lazy(()=>import('@/features/rent-ops/rent-ops-workspace'));
const RmWorkspace=lazy(()=>import('@/features/rent-ops/workspace/rm-workspace'));
export default function RentOpsPage(){
 const classic=new URLSearchParams(window.location.search).get('ui')==='classic';
 return <Suspense fallback={<main className="ro-loading" role="status">Opening Rent Operations…</main>}>{classic?<ClassicWorkspace/>:<RmWorkspace/>}</Suspense>;
}
