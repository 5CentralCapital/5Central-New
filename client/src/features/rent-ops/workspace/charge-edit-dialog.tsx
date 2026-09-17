import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { rentOpsAuthClient } from "../auth";
import { requireCentsInput } from "../money";
import "./payment-edit-dialog.css";

type EditContext = { expectedRevision: string; charge: {amountCents:number;postedOn:string;category?:string;dueOn?:string;description?:string}; appliedCents:number };
async function request(path:string, body?:unknown) {
  const response=await rentOpsAuthClient.request(`/api/rent-ops/${path}`,body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{});
  const data=await response.json();
  if(!response.ok) throw Object.assign(new Error(typeof data.error==="string"?data.error:"The charge could not be saved."),{definitive:response.status>=400&&response.status<500});
  return data;
}
export function ChargeEditDialog({id,tenantName,onClose,onSaved}:{id:string;tenantName:string;onClose:()=>void;onSaved:()=>Promise<void>}) {
  const client=useQueryClient();
  const [context,setContext]=useState<EditContext>();
  const [amount,setAmount]=useState("");const [date,setDate]=useState("");const [method,setMethod]=useState("");const [description,setDescription]=useState("");
  const [due,setDue]=useState("");
  const [error,setError]=useState("");const [busy,setBusy]=useState(false);const [saved,setSaved]=useState(false);
  const [operationId]=useState(()=>crypto.randomUUID());
  const [pending,setPending]=useState<object>();
  useEffect(()=>{let active=true;request(`charges/${encodeURIComponent(id)}/edit`).then((data:EditContext)=>{if(!active)return;setContext(data);setAmount((data.charge.amountCents/100).toFixed(2));setDate(data.charge.postedOn);setMethod(data.charge.category??"");setDescription(data.charge.description??"Charge");setDue(data.charge.dueOn??"");}).catch(err=>{if(active)setError(err.message);});return()=>{active=false;};},[id]);
  async function refresh(){
    // Reports and the workspace use separate cache roots. Invalidate both,
    // including inactive pages, before confirming a completed correction.
    await client.invalidateQueries({predicate:q=>String(q.queryKey[0]).startsWith("rent-ops")},{throwOnError:true});
    await onSaved();onClose();
  }
  async function save(event:FormEvent){event.preventDefault();if(!context||busy)return;setBusy(true);setError("");try{
    if(!saved){const body=pending??{id:operationId,expectedRevision:context.expectedRevision,amountCents:requireCentsInput(amount,"Amount"),postedOn:date,category:method||null,dueOn:due||null,description};
      setPending(body);await request(`charges/${encodeURIComponent(id)}/corrections`,body);setSaved(true);}
    await refresh();
  }catch(err){if((err as {definitive?:boolean})?.definitive)setPending(undefined);setError(err instanceof Error?err.message:"Unable to save charge.");}finally{setBusy(false);}}
  return <Dialog open onOpenChange={open=>{if(!open&&!busy)onClose();}}><DialogContent className="rops-payment-dialog" onEscapeKeyDown={e=>{if(busy)e.preventDefault();}} onPointerDownOutside={e=>e.preventDefault()}><DialogHeader><DialogTitle>Edit charge</DialogTitle><DialogDescription>{tenantName}</DialogDescription></DialogHeader>
    <form onSubmit={save}>
      {!context&&!error&&<p role="status">Loading charge…</p>}
      {context&&<fieldset disabled={busy||saved||!!pending}><div className="rops-payment-fields">
        <label>Amount<input autoFocus required inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)}/></label>
        <label>Charge date<input required type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>
        <label>Due date<input type="date" value={due} onChange={e=>setDue(e.target.value)}/></label>
        <label>Category<select value={method} onChange={e=>setMethod(e.target.value)}><option value="">Not recorded</option>{Object.entries({base_rent:"Rent",recurring_fee:"Recurring fee",one_time_fee:"One-time fee",security_deposit:"Security deposit",refundable_pet_deposit:"Refundable pet deposit",move_in_funds:"Move-in funds",subsidy:"Subsidy",unapplied_cash:"Unapplied cash",other:"Other"}).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
        <label className="rops-payment-wide">Description<input required maxLength={240} value={description} onChange={e=>setDescription(e.target.value)}/></label>
      </div><p>This edits this posted charge only. Recurring schedules remain unchanged.</p>{["security_deposit","refundable_pet_deposit","move_in_funds","subsidy"].includes(method)&&<p>Changing the charge does not record money received, refund a deposit, or change a subsidy contract.</p>}{context.appliedCents>0&&<p>Existing payments stay applied up to the corrected amount. Any excess becomes unapplied credit.</p>}</fieldset>}
      {saved&&<p role="status">Charge saved. Refreshing the updated records…</p>}
      {error&&<p role="alert" className="rops-payment-error">{saved?"Saved, but the page could not refresh. Retry refresh. ":""}{error}</p>}
      <DialogFooter><button type="button" disabled={busy} onClick={onClose}>Cancel</button>{context&&<button className="rops-payment-save" disabled={busy} type="submit">{busy?"Saving…":saved?"Retry refresh":pending?"Retry save":"Save charge"}</button>}</DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
