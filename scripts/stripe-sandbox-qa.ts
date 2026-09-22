/** Explicit opt-in, real Stripe sandbox QA. Credentials exist in process memory only. */
import Stripe from 'stripe';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { stripeProvider } from '../server/rent-ops/payments/provider';
import type { createTenantQa as CreateTenantQa } from './tenant-local-qa';

export const EXPECTED_STRIPE_ACCOUNT = 'acct_1UDBUjGr5LUo8wLL';
const ORIGIN = 'http://127.0.0.1:4176';
const EVENTS = ['checkout.session.completed','checkout.session.expired','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','payment_intent.succeeded','payment_intent.processing','payment_intent.payment_failed','payment_intent.canceled','refund.created','refund.updated','charge.dispute.created','charge.dispute.updated','charge.dispute.closed'];
export function sandboxKey(env: NodeJS.ProcessEnv): string {
  if (env.QA_STRIPE_SANDBOX !== '1') throw new Error('Sandbox QA disabled. Set QA_STRIPE_SANDBOX=1 to opt in.');
  if (env.NODE_ENV === 'production') throw new Error('Sandbox QA cannot run in production.');
  if (!/^sk_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY ?? '')) throw new Error('A Stripe test secret key is required in STRIPE_SECRET_KEY.');
  return env.STRIPE_SECRET_KEY!;
}
/** CLI output is private; this extractor never logs its input. */
export function extractWebhookSecret(output: string): string | undefined {
  return output.match(/\bwhsec_[A-Za-z0-9]+(?=\s|[)\]}.,]|$)/)?.[0];
}
export function assertSandboxAccount(account: {id:string}): void {
  if (account.id !== EXPECTED_STRIPE_ACCOUNT) throw new Error('Stripe account mismatch. Sandbox QA stopped.');
}

export async function launchStripeSandboxQa() {
  const key = sandboxKey(process.env);
  // Read-only account verification MUST precede listener or payment-provider setup.
  let account: Stripe.Account;
  try { account = await new Stripe(key, {maxNetworkRetries:0, timeout:15000}).accounts.retrieve(null); }
  catch { throw new Error('Stripe sandbox account verification failed. No listener was started.'); }
  assertSandboxAccount(account);
  const listener = spawn('stripe', ['listen','--forward-to',`${ORIGIN}/api/tenant/payments/webhook`,'--events',EVENTS.join(',')], {
    stdio: ['ignore','pipe','pipe'],
    // Official CLI STRIPE_API_KEY takes precedence over saved profiles. Never pass a key in argv.
    env: {PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,STRIPE_API_KEY:key,STRIPE_DEVICE_NAME:'5central-local-sandbox-qa'},
  });
  let qa: Awaited<ReturnType<typeof CreateTenantQa>> | undefined;
  let stopped = false;
  const stop = async () => {
    if(stopped) return; stopped = true;
    listener.kill('SIGTERM');
    if(qa) { await new Promise<void>(done=>qa!.server.close(()=>done())); await qa.db.close(); }
  };
  try {
    const secret = await new Promise<string>((accept,reject) => {
      let buffer = '';
      const timeout = setTimeout(()=>finish(undefined),30000);
      const finish = (value: string | undefined) => {
        clearTimeout(timeout); listener.stdout.off('data',read); listener.stderr.off('data',read);
        buffer=''; value ? accept(value) : reject(new Error('Stripe listener did not become ready. Check CLI installation and sandbox access.'));
      };
      const read = (chunk: Buffer) => {
        buffer=(buffer+chunk.toString()).slice(-8192);
        // Wait for a delimiter so a chunk boundary cannot truncate the signing secret.
        const found = extractWebhookSecret(buffer.replace(/whsec_[A-Za-z0-9]+$/, ''));
        if(found) finish(found);
      };
      listener.stdout.on('data',read); listener.stderr.on('data',read);
      listener.once('error',()=>finish(undefined)); listener.once('exit',()=>finish(undefined));
    });
    // Drain all subsequent output privately. It may contain signing secrets or request data.
    listener.stdout.resume(); listener.stderr.resume();
    const provider = stripeProvider({NODE_ENV:'development',STRIPE_SECRET_KEY:key,STRIPE_WEBHOOK_SECRET:secret,TENANT_PORTAL_ORIGIN:ORIGIN});
    if(!provider || provider.live) throw new Error('Sandbox provider validation failed.');
    const {createTenantQa} = await import('./tenant-local-qa');
    // The fixture advances its accounting clock to move-in; Stripe expiry must
    // remain relative to real wall time in this explicit sandbox harness.
    const sandboxProvider = { ...provider, async createCheckout(payment: Parameters<typeof provider.createCheckout>[0]) {
      try { return await provider.createCheckout({ ...payment, expiresAt: new Date(Date.now() + 35 * 60_000).toISOString() }); }
      catch (error) {
        const details = error && typeof error === "object" ? error as Record<string, unknown> : {};
        const safe = (name: string) => typeof details[name] === "string" && /^[A-Za-z0-9_.\[\]-]{1,80}$/.test(details[name] as string) ? details[name] : "unknown";
        console.log(`Sandbox provider diagnostic: ${JSON.stringify({type:safe("type"),code:safe("code"),param:safe("param")})}`);
        throw error;
      }
    } };
    qa = await createTenantQa({provider:sandboxProvider});
    if(listener.exitCode !== null || listener.signalCode !== null || stopped) throw new Error('Stripe listener stopped before QA was ready.');
    listener.once('exit',()=>{ console.error('Stripe listener stopped. Local sandbox QA is shutting down.'); void stop(); });
    const {runTenantFlow} = await import('./tenant-flow-qa');
    await runTenantFlow(qa,{serve:true,untilBilling:true});
    process.once('SIGINT',()=>void stop()); process.once('SIGTERM',()=>void stop());
    console.log(`Stripe sandbox account verified: ${EXPECTED_STRIPE_ACCOUNT}`);
    console.log(`TEST ONLY: ${ORIGIN}/qa — real Stripe sandbox, synthetic tenants, local email sink.`);
    return {qa,stop};
  } catch { await stop(); throw new Error('Stripe sandbox QA startup failed. Listener stopped; no credentials were logged.'); }
}

if(process.argv[1] && resolve(process.argv[1])===resolve('scripts/stripe-sandbox-qa.ts')) {
  launchStripeSandboxQa().catch(error=>{console.error(error.message);process.exitCode=1;});
}
