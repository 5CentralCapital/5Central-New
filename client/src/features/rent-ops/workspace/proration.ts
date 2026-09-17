export function prorateRent(monthlyCents: number, moveIn: string) {
  if (!Number.isSafeInteger(monthlyCents) || monthlyCents <= 0) throw Error("Enter the full monthly rent.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(moveIn)) throw Error("Enter the move-in date in the charge date field.");
  const date = new Date(`${moveIn}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== moveIn) throw Error("Enter a valid move-in date.");
  const end = new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0));
  const daysInMonth = end.getUTCDate(), days = daysInMonth-date.getUTCDate()+1;
  const amountCents = Math.round(monthlyCents / daysInMonth * days);
  return {amountCents,days,daysInMonth,through:end.toISOString().slice(0,10)};
}
