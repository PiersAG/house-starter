const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL;

export const metadata = {
  title: "Contact",
  description: "Get in touch with our support team.",
};

export default function ContactPage() {
  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="text-2xl font-semibold text-text-primary">Contact us</h1>
      <p className="mt-3 text-text-secondary">
        Need help or have a question? We read and reply to every message.
      </p>
      <div className="mt-8 rounded-lg border border-border bg-surface p-6">
        {SUPPORT_EMAIL ? (
          <p className="text-text-primary">
            Email us at{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="font-medium underline underline-offset-4">
              {SUPPORT_EMAIL}
            </a>
            .
          </p>
        ) : (
          <p className="text-text-secondary">
            Support contact isn&apos;t configured yet. Set{" "}
            <code className="rounded bg-surface px-1 py-0.5 text-sm">NEXT_PUBLIC_SUPPORT_EMAIL</code>{" "}
            to enable the contact link.
          </p>
        )}
      </div>
    </main>
  );
}
