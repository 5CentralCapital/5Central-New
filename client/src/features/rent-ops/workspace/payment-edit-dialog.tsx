import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { rentOpsAuthClient } from "../auth";
import { requireCentsInput } from "../money";
import "./payment-edit-dialog.css";

type EditContext = { expectedRevision: string; payment: {amountCents:number;postedOn:string;paymentMethod?:string;description?:string}; allocations:{chargeTransactionId:string;amountCents:number}[] };
async function request(path:string, body?:unknown) {
  const response=await rentOpsAuthClient.request(`/api/rent-ops/${path}`,body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{});
  const data=await response.json();
  if(!response.ok) throw Object.assign(new Error(typeof data.error==="string"?data.error:"The payment could not be saved."),{definitive:response.status>=400&&response.status<500});
  return data;
}
export function PaymentEditDialog({id,tenantName,onClose,onSaved}:{id:string;tenantName:string;onClose:()=>void;onSaved:()=>Promise<void>}) {
  const client=useQueryClient();
  const [context,setContext]=useState<EditContext>();
  const [amount,setAmount]=useState("");const [date,setDate]=useState("");const [method,setMethod]=useState("");const [description,setDescription]=useState("");
  const [allocations,setAllocations]=useState<string[]>([]);
  const [error,setError]=useState("");const [busy,setBusy]=useState(false);const [saved,setSaved]=useState(false);
  const [operationId]=useState(()=>crypto.randomUUID());
  const [pending,setPending]=useState<object>();
  useEffect(()=>{let active=true;request(`payments/${encodeURIComponent(id)}/edit`).then((data:EditContext)=>{if(!active)return;setContext(data);setAmount((data.payment.amountCents/100).toFixed(2));setDate(data.payment.postedOn);setMethod(data.payment.paymentMethod??"");setDescription(data.payment.description??"Payment");setAllocations(data.allocations.map(row=>(row.amountCents/100).toFixed(2)));}).catch(err=>{if(active)setError(err.message);});return()=>{active=false;};},[id]);
  async function refresh(){
    // Reports and the workspace use separate cache roots. Invalidate both,
    // including inactive pages, before confirming a completed correction.
    await client.invalidateQueries({predicate:q=>String(q.queryKey[0]).startsWith("rent-ops")},{throwOnError:true});
    await onSaved();onClose();
  }
  async function save(event:FormEvent){event.preventDefault();if(!context||busy)return;setBusy(true);setError("");try{
    if(!saved){const body=pending??{id:operationId,expectedRevision:context.expectedRevision,amountCents:requireCentsInput(amount,"Amount"),postedOn:date,paymentMethod:method,description,allocations:context.allocations.map((row,i)=>({chargeTransactionId:row.chargeTransactionId,amountCents:allocations[i].trim()==="0"||Number(allocations[i])===0?0:requireCentsInput(allocations[i],"Applied amount")})).filter(row=>row.amountCents>0)};
      setPending(body);await request(`payments/${encodeURIComponent(id)}/corrections`,body);setSaved(true);}
    await refresh();
  }catch(err){if((err as {definitive?:boolean})?.definitive)setPending(undefined);setError(err instanceof Error?err.message:"Unable to save payment.");}finally{setBusy(false);}}
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose();}}><DialogContent className="rops-payment-dialog" onEscapeKeyDown={e=>{if(busy)e.preventDefault();}} onPointerDownOutside={e=>e.preventDefault()}><DialogHeader><DialogTitle>Edit payment</DialogTitle><DialogDescription>{tenantName}</DialogDescription></DialogHeader>
    <form onSubmit={save}>
      {!context&&!error&&<p role="status">Loading payment…</p>}
      {context&&<fieldset disabled={busy||saved||!!pending}><div className="rops-payment-fields">
        <label>Amount<input autoFocus required inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)}/></label>
        <label>Payment date<input required type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>
        <label className="rops-payment-wide">Payment method<select required value={method} onChange={e=>setMethod(e.target.value)}><option value="">Select method</option>{["ach","cash","check","money_order","zelle","other"].map(value=><option key={value} value={value}>{({ach:"ACH",money_order:"Money order",zelle:"Zelle"} as Record<string,string>)[value]??value[0].toUpperCase()+value.slice(1)}</option>)}</select></label>
        <label className="rops-payment-wide">Description<input required maxLength={240} value={description} onChange={e=>setDescription(e.target.value)}/></label>
      </div>{context.allocations.length>0&&<details><summary>Applied to charges</summary>{context.allocations.map((row,i)=><label className="rops-payment-allocation" key={row.chargeTransactionId}>Applied amount {i+1}<input inputMode="decimal" value={allocations[i]} onChange={e=>setAllocations(prior=>prior.map((value,j)=>i===j?e.target.value:value))}/></label>)}<p>Reduce applied amounts if the corrected payment is smaller. Enter 0 to unapply.</p></details>}</fieldset>}
      {saved&&<p role="status">Payment saved. Refreshing the updated records…</p>}
      {error&&<p role="alert" className="rops-payment-error">{saved?"Saved, but the page could not refresh. Retry refresh. ":""}{error}</p>}
      <DialogFooter><button type="button" disabled={busy} onClick={onClose}>Cancel</button>{context&&<button className="rops-payment-save" disabled={busy} type="submit">{busy?"Saving…":saved?"Retry refresh":pending?"Retry save":"Save payment"}</button>}</DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
