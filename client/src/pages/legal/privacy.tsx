import { LegalPage, LegalSection, LEGAL_CONTACT_EMAIL } from "./legal-layout";

export default function PrivacyPolicy() {
  return (
    <LegalPage title="Privacy Policy" testId="privacy-policy-page">
      <LegalSection title="1. Who we are">
        <p>
          5Central Capital LLC ("5Central," "we," "us") operates 5Central Ops, formerly 5Central Rent Ops ("5Central Ops" or the "App"), a private
          property-management and accounting application used to run 5Central's own real estate business and affiliated
          entities. This policy explains what information the App collects, how it is used, and the choices available,
          including for data accessed through the QuickBooks Online integration.
        </p>
      </LegalSection>

      <LegalSection title="2. Who uses the App">
        <p>
          The manager workspace is available only to personnel authorized by 5Central. The QuickBooks connection is
          available only to the QuickBooks Online company administrator who authorizes it. Residents and rental
          applicants may use separate tenant and application pages, which are also covered by this policy.
        </p>
      </LegalSection>

      <LegalSection title="3. Information we collect">
        <ul className="list-disc pl-6 space-y-2">
          <li><strong>Account information</strong> for authorized users, such as name, email address, and sign-in identifiers from our identity provider (Auth0 with Google sign-in).</li>
          <li><strong>QuickBooks Online data</strong> that an authorized administrator chooses to connect, such as company information, chart of accounts, customers, vendors, items, invoices, bills, expenses, journal entries, payment, deposit, transfer and credit records, and financial reports.</li>
          <li><strong>Property-operations data</strong>, such as properties, units, leases, tenants, applicants, work orders, projects, and related documents.</li>
          <li><strong>Payment and banking information</strong> handled by our processors. Card and ACH payments are processed on Stripe-hosted pages; the App does not store full card numbers. Bank data may be retrieved through Plaid when an authorized user links an account.</li>
          <li><strong>Technical and diagnostic information</strong>, such as request logs, error codes, and Intuit transaction IDs (intuit_tid), used to operate and troubleshoot the App.</li>
        </ul>
      </LegalSection>

      <LegalSection title="4. How we use QuickBooks data">
        <ul className="list-disc pl-6 space-y-2">
          <li>We use QuickBooks data only to provide the App's accounting features to 5Central and its own entities: reading, creating, and updating supported accounting records and producing financial reports.</li>
          <li>We access a QuickBooks company only after its administrator authorizes the connection through Intuit's OAuth 2.0 process, and only within the scopes granted.</li>
          <li>We do not sell QuickBooks data, and we do not share one company's QuickBooks data with any other customer or outside business.</li>
          <li>We do not use QuickBooks data to train artificial-intelligence or machine-learning models.</li>
          <li>The App does not use the QuickBooks Payments API and does not move funds through Intuit.</li>
        </ul>
      </LegalSection>

      <LegalSection title="5. AI assistant tools">
        <p>
          Authorized 5Central administrators may use authenticated assistant tools (for example, OpenAI ChatGPT or Codex
          connected through the App's secured tool interface) to request information or actions inside the App. When an
          administrator makes such a request, the information needed to answer it may be processed by that AI provider
          under its terms. These tools are available only to authorized administrators, and we do not use QuickBooks data
          to train AI models.
        </p>
      </LegalSection>

      <LegalSection title="6. How we use other information">
        <p>
          We use the information described above to operate, maintain, and secure the App; manage properties, leases,
          and accounting for 5Central's entities; process rent and related payments through our processors; communicate
          with residents, applicants, vendors, and partners; comply with legal obligations; and investigate and resolve
          technical issues.
        </p>
      </LegalSection>

      <LegalSection title="7. Service providers">
        <p>We rely on service providers that process information on our behalf, including:</p>
        <ul className="list-disc pl-6 space-y-2">
          <li>Intuit (QuickBooks Online), for accounting data the administrator connects;</li>
          <li>Replit, for application hosting and database services;</li>
          <li>Auth0 and Google, for manager sign-in;</li>
          <li>Stripe, for hosted card and ACH payments;</li>
          <li>Plaid, for bank-account data;</li>
          <li>Google (Gmail), for operational email; and</li>
          <li>OpenAI, when an administrator uses the assistant tools described above.</li>
        </ul>
        <p>We may also disclose information when required by law or to protect the rights, property, or safety of 5Central or others.</p>
      </LegalSection>

      <LegalSection title="8. Security">
        <p>
          We use reasonable administrative, technical, and physical safeguards. QuickBooks OAuth access and refresh
          tokens are encrypted at rest and are never displayed in the browser or written to logs. App credentials are
          stored as server-side secrets. Access to the manager workspace requires authenticated sign-in. No method of
          transmission or storage is completely secure, and we cannot guarantee absolute security.
        </p>
      </LegalSection>

      <LegalSection title="9. Retention and disconnecting QuickBooks">
        <p>
          An administrator can disconnect QuickBooks at any time from within QuickBooks Online or from the App. After
          disconnection, the App stops accessing that QuickBooks company and its stored tokens are revoked or cleared.
          Accounting records already brought into the App are kept as part of 5Central's business records for as long
          as needed for accounting, tax, and legal purposes, unless deletion is requested and permitted by law.
        </p>
      </LegalSection>

      <LegalSection title="10. Your choices">
        <p>
          You may ask us to access, correct, or delete information about you by contacting us at the address below. We
          will respond as required by applicable law. Residents and applicants may also contact us about information in
          their tenant or application records.
        </p>
      </LegalSection>

      <LegalSection title="11. Children">
        <p>The App is not directed to children under 13, and we do not knowingly collect their personal information.</p>
      </LegalSection>

      <LegalSection title="12. Changes to this policy">
        <p>We may update this policy from time to time. The effective date at the top shows when it was last revised.</p>
      </LegalSection>

      <LegalSection title="13. Contact">
        <p>
          5Central Capital LLC, Tampa, Florida. Email{" "}
          <a className="text-accent-gold hover:underline" href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
