// Public security page (app-business-core issue 524, Matt Murphy item 151):
// encryption, data isolation, scanning, incidents, data location, backups and
// how to report a flaw. The words live in lib/security-page.ts, where a test
// checks each claim against the code it describes.

import {
  isolationSection,
  profileSections,
  securityContact,
  TEMPLATE_SECTIONS,
  type SecuritySection,
} from "@/lib/security-page";

export const metadata = {
  title: "Security",
  description: "How this app protects your data, and how to report a security problem.",
};

export const dynamic = "force-dynamic";

function Section({ section }: { section: SecuritySection }) {
  return (
    <section id={section.id} className="mt-8">
      <h2 className="text-lg font-semibold text-text-primary">{section.heading}</h2>
      {section.paragraphs.map((p) => (
        <p key={p} className="mt-2 text-text-secondary">
          {p}
        </p>
      ))}
    </section>
  );
}

export default function SecurityPage() {
  const contact = securityContact();
  const [encryption, ...rest] = TEMPLATE_SECTIONS;
  const sections = [encryption, isolationSection(), ...rest, ...profileSections(undefined, contact)];
  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6 sm:py-16">
      <h1 className="text-2xl font-semibold text-text-primary">Security</h1>
      <p className="mt-3 text-text-secondary">
        How this app protects your data, and what to do if you find a security problem.
      </p>
      {sections.map((s) => (
        <Section key={s.id} section={s} />
      ))}
      <section id="report" className="mt-8 rounded-lg border border-border bg-surface p-6">
        <h2 className="text-lg font-semibold text-text-primary">Report a security problem</h2>
        {contact ? (
          <p className="mt-2 text-text-primary">
            Email{" "}
            <a href={`mailto:${contact}`} className="font-medium underline underline-offset-4">
              {contact}
            </a>{" "}
            with what you found, the page or address involved, and the steps to see it.
          </p>
        ) : (
          <p className="mt-2 text-text-primary">
            Tell us through the{" "}
            <a href="/contact" className="font-medium underline underline-offset-4">
              contact page
            </a>{" "}
            with what you found, the page or address involved, and the steps to see it.
          </p>
        )}
        <p className="mt-2 text-text-secondary">
          We will confirm we have your report and tell you what we are doing about it. Please do not
          access, change or delete other people&apos;s data, and give us a fair chance to fix the
          problem before you tell anyone else. We will not take action against anyone who reports a
          problem in good faith this way.
        </p>
      </section>
    </main>
  );
}
