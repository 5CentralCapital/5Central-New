import { createCompanyDemoApp } from '../../server/company/demo';

const demo = await createCompanyDemoApp({ companyDemoData: true });
const listener = demo.app.listen(Number(process.env.ROPS_DEMO_PORT ?? 4176), '127.0.0.1', () => {
  const address = listener.address();
  if (address && typeof address === 'object') console.log(`Synthetic company workspace: http://127.0.0.1:${address.port}/ops?section=projects`);
});
async function close() {
  listener.close(); await demo.close();
}
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
