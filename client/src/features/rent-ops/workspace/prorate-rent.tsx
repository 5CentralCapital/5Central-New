import {useState} from "react";
import {requireCentsInput} from "../money";
import {prorateRent} from "./proration";
export function ProrateRent({amount,date,onApply}:{amount:string;date:string;onApply:(amount:string)=>void}) {
  const [monthly,setMonthly]=useState<string>();
  const [error,setError]=useState("");
  function calculate(){try{const base=monthly??amount;const result=prorateRent(requireCentsInput(base,"Monthly rent"),date);setMonthly(base);onApply((result.amountCents/100).toFixed(2));setError("");}catch(e){setError(e instanceof Error?e.message:"Check the rent and date.");}}
  return <div className="rops-proration"><label>Full monthly rent<input inputMode="decimal" value={monthly??amount} onChange={e=>{setMonthly(e.target.value);}}/></label><button type="button" onClick={calculate}>Prorate rent</button>{error&&<p role="alert">{error}</p>}</div>;
}
