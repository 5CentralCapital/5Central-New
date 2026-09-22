import { z } from "zod";
const text = (limit:number) => z.string().regex(/^[^\x00-\x1f\x7f]*$/,"Control characters are not permitted").trim().min(1).max(limit);
export const phoneMethodsSchema = z.array(z.object({
  id:text(160).optional(),value:text(80),type:text(80).optional(),isPrimary:z.boolean().optional(),isTextReady:z.boolean().optional(),
}).strict()).max(20).superRefine((methods,context)=>{
  if(methods.filter(method=>method.isPrimary===true).length>1) context.addIssue({code:z.ZodIssueCode.custom,message:"Select at most one primary phone method"});
  const ids=methods.flatMap(method=>method.id?[method.id]:[]);
  if(new Set(ids).size!==ids.length) context.addIssue({code:z.ZodIssueCode.custom,message:"Phone method identifiers must be unique"});
});
