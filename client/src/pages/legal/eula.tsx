import React from "react";
import { LegalPage, LegalSection, LEGAL_CONTACT_EMAIL } from "./legal-layout";

export default function EndUserLicenseAgreement() {
  return (
    <LegalPage title="End-User License Agreement" testId="eula-page">
      <LegalSection title="1. Agreement">
        <p>
          This End-User License Agreement ("Agreement") is between 5Central Capital LLC ("5Central," "we," "us") and each
          person or entity that accesses 5Central Ops (formerly 5Central Rent Ops, the "App"), including its QuickBooks Online integration
          ("you"). By accessing the App or connecting a QuickBooks Online company to it, you agree to this Agreement. If
          you do not agree, do not use the App.
        </p>
      </LegalSection>

      <LegalSection title="2. License">
        <p>
          Subject to this Agreement, 5Central grants you a limited, non-exclusive, non-transferable, revocable license to
          use the App solely for the internal business operations of 5Central and its affiliated entities. You may not
          sell, sublicense, rent, or provide the App to outside businesses, or copy, modify, reverse engineer, or create
          derivative works of the App except as permitted by law.
        </p>
      </LegalSection>

      <LegalSection title="3. Authorized users">
        <p>
          The manager workspace is for personnel authorized by 5Central. You are responsible for keeping your sign-in
          credentials secure and for activity under your account. Notify us promptly of any unauthorized use.
        </p>
      </LegalSection>

      <LegalSection title="4. QuickBooks Online connection">
        <ul className="list-disc pl-6 space-y-2">
          <li>Only a QuickBooks Online company administrator with authority to act for that company may connect it to the App.</li>
          <li>By connecting, you authorize the App to access that company's QuickBooks Online data within the scopes you approve, and to read, create, and update supported accounting records and reports on your instructions.</li>
          <li>You are responsible for reviewing accounting entries made through the App. The App does not use the QuickBooks Payments API and does not move funds through Intuit.</li>
          <li>You may disconnect at any time from QuickBooks Online or from the App. Disconnecting ends the App's access to that company.</li>
        </ul>
      </LegalSection>

      <LegalSection title="5. Data and privacy">
        <p>
          Our collection and use of information, including QuickBooks data, is described in our{" "}
          <a className="text-accent-gold hover:underline" href="/legal/privacy">Privacy Policy</a>, which is part of this Agreement.
        </p>
      </LegalSection>

      <LegalSection title="6. Acceptable use">
        <p>
          You agree not to use the App to violate any law or third-party right; to access data you are not authorized to
          access; to interfere with the App's security or operation; or to exceed the usage limits of any connected
          service, including Intuit's platform.
        </p>
      </LegalSection>

      <LegalSection title="7. Third-party services">
        <p>
          The App works with third-party services, including Intuit QuickBooks Online, Stripe, Plaid, Auth0, Google,
          Replit, and OpenAI. Your use of those services is governed by their own terms. Intuit and QuickBooks are
          trademarks of Intuit Inc. Intuit is not a party to this Agreement and is not responsible for the App.
        </p>
      </LegalSection>

      <LegalSection title="8. Disclaimer of warranties">
        <p>
          The App is provided "as is" and "as available." To the fullest extent permitted by law, 5Central disclaims all
          warranties, express or implied, including warranties of merchantability, fitness for a particular purpose, and
          non-infringement, and does not warrant that the App will be uninterrupted or error-free.
        </p>
      </LegalSection>

      <LegalSection title="9. Limitation of liability">
        <p>
          To the fullest extent permitted by law, 5Central will not be liable for any indirect, incidental, special,
          consequential, or punitive damages, or for lost profits, revenue, or data, arising out of or related to the
          App or this Agreement.
        </p>
      </LegalSection>

      <LegalSection title="10. Termination">
        <p>
          We may suspend or end your access to the App at any time. You may stop using the App and disconnect QuickBooks
          at any time. Sections 5 and 7 through 12 survive termination.
        </p>
      </LegalSection>

      <LegalSection title="11. Changes">
        <p>We may update this Agreement from time to time. Continued use after an update means you accept the revised Agreement.</p>
      </LegalSection>

      <LegalSection title="12. Governing law">
        <p>This Agreement is governed by the laws of the State of Florida, without regard to its conflict-of-laws rules.</p>
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
