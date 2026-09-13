// Reuse immutable formatters; keep all existing value validation at call sites.
export const usdCurrencyFormatter = new Intl.NumberFormat('en-US', {style:'currency',currency:'USD'});
export const usdAccountingFormatter = new Intl.NumberFormat('en-US', {style:'currency',currency:'USD',currencySign:'accounting'});
export const utcCalendarDateFormatter = new Intl.DateTimeFormat('en-US', {month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
