import React from "react";
import { LEGAL_CONTACT_EMAIL } from "./legal/legal-layout";

export const QUICKBOOKS_RECONNECT_PATH = "/ops?section=accounting";

export default function QuickBooksDisconnected() {
  return (
    <main className="min-h-screen bg-white pt-24 pb-20" data-testid="quickbooks-disconnected-page">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
        <p className="text-sm uppercase tracking-wide text-gray-500">5Central Ops</p>
        <h1 className="mt-2 text-3xl font-serif font-bold text-gray-900">QuickBooks has been disconnected</h1>
        <div className="mt-6 space-y-4 text-gray-700 leading-relaxed">
          <p>
            5Central Ops no longer has access to this QuickBooks Online company. It will not read, create, or update any
            QuickBooks records until an administrator connects it again.
          </p>
          <p>
            Accounting records that were already brought into 5Central Ops stay in 5Central Ops. If you use 5Central Ops accounting
            features before reconnecting, you will be asked to reconnect QuickBooks.
          </p>
        </div>
        <div className="mt-8 flex flex-wrap gap-3">
          <a className="inline-block rounded-md bg-gray-900 px-5 py-3 text-white hover:bg-gray-800" href={QUICKBOOKS_RECONNECT_PATH}>Reconnect QuickBooks</a>
          <a className="inline-block rounded-md border border-gray-300 px-5 py-3 text-gray-900 hover:bg-gray-50" href={`mailto:${LEGAL_CONTACT_EMAIL}?subject=5Central%20Ops%20QuickBooks%20support`}>Contact support</a>
        </div>
      </div>
    </main>
  );
}
