import React, { type ReactNode } from "react";

export const LEGAL_EFFECTIVE_DATE = "September 23, 2026";
export const LEGAL_CONTACT_EMAIL = "michael@5central.capital";

export function LegalSection({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
      <div className="mt-3 space-y-3 text-gray-700 leading-relaxed">{children}</div>
    </section>
  );
}

export function LegalPage({ title, testId, children }: { readonly title: string; readonly testId: string; readonly children: ReactNode }) {
  return (
    <main className="min-h-screen bg-white pt-24 pb-20" data-testid={testId}>
      <article className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <p className="text-sm uppercase tracking-wide text-gray-500">5Central Ops</p>
        <h1 className="mt-2 text-3xl md:text-4xl font-serif font-bold text-gray-900">{title}</h1>
        <p className="mt-3 text-sm text-gray-500">Effective {LEGAL_EFFECTIVE_DATE}</p>
        {children}
        <footer className="mt-12 border-t border-gray-200 pt-6 text-sm text-gray-600">
          <p>
            Questions: <a className="text-accent-gold hover:underline" href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>
          </p>
          <p className="mt-2 space-x-4">
            <a className="hover:underline" href="/legal/eula">End-User License Agreement</a>
            <a className="hover:underline" href="/legal/privacy">Privacy Policy</a>
          </p>
        </footer>
      </article>
    </main>
  );
}
