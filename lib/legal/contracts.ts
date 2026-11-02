// The terms of service, the customer data processing agreement and the master
// service agreement with its service levels (app-business-core issues 349 and
// 774; Matt Murphy #155: "data processing agreement ... if you process data on
// behalf of another business a DPA defines who is responsible for what";
// "master service agreement"; #288: "terms of service with liability limit,
// conduct rules, dispute resolution").
//
// Templates built from config/legal.ts. NOT legal advice and not reviewed by a
// lawyer: the CEO has them reviewed before the first customer (config/legal.ts).

import { legalDetails, type LegalDetails } from "@/config/legal";
import { ERASURE_CONFIRM_HOURS } from "@/config/personal-data";
import { refundPolicy } from "@/config/refund-policy";
import type { LegalDocument } from "@/lib/legal/types";

export function termsOfService(d: LegalDetails = legalDetails): LegalDocument {
  return {
    path: "/terms",
    file: "terms-of-service.md",
    title: "Terms of service",
    summary: `The agreement between you and ${d.controllerName} when you use ${d.appName}.`,
    sections: [
      {
        heading: "Who we are",
        paragraphs: [`${d.appName} is provided by ${d.controllerName}, ${d.postalAddress}. Contact: ${d.contactEmail}.`],
      },
      {
        heading: "The service",
        paragraphs: [
          `${d.appName} is an online service for running your business. These terms apply when you create an account. If you use it for a business, you accept them on that business's behalf.`,
        ],
      },
      {
        heading: "Your account",
        bullets: [
          "Give accurate details and keep your password and any second sign-in step to yourself.",
          "You are responsible for what happens under your account.",
          "Tell us at once if you think someone else has got into it.",
        ],
      },
      {
        heading: "Acceptable use",
        paragraphs: ["You must not use the service to:"],
        bullets: [
          "break the law or anyone else's rights;",
          "send spam or anything harmful, abusive or misleading;",
          "upload malware, or try to get round its security, its limits or another customer's data;",
          "overload it, scrape it or copy it, or resell it without our written agreement.",
        ],
      },
      {
        heading: "Subscription and payments",
        paragraphs: [
          "Prices and what each plan includes are shown before you pay. Payments are taken by Stripe. You can cancel at any time from your billing page; cancelling stops the next payment.",
          `Refunds follow the refund policy (/refund-policy): a full refund within ${refundPolicy.firstPaymentRefundDays} days of your first payment.`,
        ],
      },
      {
        heading: "Your data",
        paragraphs: [
          "Your data stays yours. We use it only to provide the service, as the privacy policy (/privacy) describes. If you hold your own customers' personal data in the app, the data processing agreement (/legal/dpa) applies to it.",
          `You can download your data or delete your account at any time from Account, Your data.`,
        ],
      },
      {
        heading: "Availability",
        paragraphs: [
          `We aim to keep the service available ${d.uptimeTargetPercent}% of each month, as the service agreement (/legal/service-agreement) describes, but we do not promise it will never be interrupted.`,
        ],
      },
      {
        heading: "Liability",
        paragraphs: [
          `Our total liability to you for any claim is limited to the fees you paid us in the ${d.liabilityCapMonths} months before the claim. We are not liable for indirect or consequential loss, or loss of profit, revenue or data you could have exported. Nothing in these terms limits liability that the law does not allow to be limited, such as for death or personal injury caused by negligence, or for fraud, or your rights as a consumer.`,
        ],
      },
      {
        heading: "Ending the agreement",
        paragraphs: [
          "You can stop at any time by cancelling your subscription and deleting your account.",
          "We may suspend or close an account that breaks these terms, telling you why, and give you the chance to export your data unless the law prevents it.",
          `If we stop providing the service we give at least ${d.changeNoticeDays} days' notice and the chance to export your data.`,
        ],
      },
      {
        heading: "Dispute resolution",
        paragraphs: [
          `If something goes wrong, write to ${d.contactEmail} first: we reply within 5 working days and try to put it right. If we cannot agree within 30 days, either of us may take the dispute to the courts of ${d.governingLaw}. If you are a consumer you may also use your local courts.`,
        ],
      },
      {
        heading: "Governing law",
        paragraphs: [`These terms are governed by the law of ${d.governingLaw}.`],
      },
      {
        heading: "Changes to these terms",
        paragraphs: [
          `We email you at least ${d.changeNoticeDays} days before a material change takes effect. Last updated ${d.updated}.`,
        ],
      },
    ],
  };
}

export function customerDpa(d: LegalDetails = legalDetails): LegalDocument {
  return {
    path: "/legal/dpa",
    file: "customer-dpa.md",
    title: "Data processing agreement",
    summary: `Who is responsible for what when your business keeps its own customers' personal data in ${d.appName}.`,
    sections: [
      {
        heading: "Who is responsible for what",
        paragraphs: [
          `You (the customer business) decide why and how your own customers' personal data is used: you are its controller. ${d.controllerName} stores and processes it only to provide ${d.appName} to you: we are your processor. This agreement forms part of the terms of service and meets Article 28 of the UK GDPR and the EU GDPR.`,
        ],
      },
      {
        heading: "The processing",
        bullets: [
          "Subject matter: providing the service under the terms of service.",
          "Duration: while your account is open, and the deletion period after.",
          "Nature and purpose: storing, showing and organising your records so you can run your business.",
          "Types of personal data: whatever you keep in the app about your customers (for example names, contact details, appointments and notes).",
          "People concerned: your customers and your staff.",
        ],
      },
      {
        heading: "Our obligations as your processor",
        bullets: [
          "We act only on your documented instructions, which are the terms, this agreement and your use of the app.",
          "Everyone who can reach the data is bound to keep it confidential.",
          "We keep it secure: encrypted in transit, each customer's data in its own database, access limited and logged.",
          "We use only the subprocessors on /subprocessors, under written terms at least as protective as these, and tell you 30 days before adding one, so you can object.",
          "We help you answer your customers' requests to see, correct or delete their data.",
          `We tell you without undue delay, and within ${ERASURE_CONFIRM_HOURS} hours, after we become aware of a breach affecting your data, and help you meet your own duties.`,
          "We help you with data protection impact assessments where the processing needs one.",
          `When the agreement ends we let you export your data for ${d.exitExportDays} days, then delete it, except where the law requires us to keep it.`,
          "We give you the information you need to show that these obligations are met, and allow a reasonable audit.",
        ],
      },
      {
        heading: "Transfers outside the UK",
        paragraphs: [
          "Where a subprocessor holds data outside the UK, the transfer is covered by the UK International Data Transfer Addendum or another lawful mechanism, as listed on /subprocessors.",
        ],
      },
      {
        heading: "Contact",
        paragraphs: [`Write to ${d.contactEmail} about this agreement.`],
      },
    ],
  };
}

export function serviceAgreement(d: LegalDetails = legalDetails): LegalDocument {
  return {
    path: "/legal/service-agreement",
    file: "service-agreement.md",
    title: "Service agreement",
    summary: `The support, availability and response times ${d.controllerName} provides for ${d.appName} (master service agreement and service levels).`,
    sections: [
      {
        heading: "What this covers",
        paragraphs: [
          "This agreement sits alongside the terms of service and the data processing agreement. If they conflict, the data processing agreement wins on personal data, then this agreement on service levels, then the terms.",
        ],
      },
      {
        heading: "Support",
        bullets: [
          `How to reach us: ${d.support.email}.`,
          `When: ${d.support.hours}.`,
          "Include what you were doing, what you expected and what happened.",
        ],
      },
      {
        heading: "Response times",
        bullets: [
          `Urgent (the service is down, or data is at risk): first response within ${d.responseHours.urgent} working hours.`,
          `Normal (something does not work as it should): first response within ${d.responseHours.normal} working hours.`,
          "Questions and requests: within 5 working days.",
        ],
      },
      {
        heading: "Availability",
        paragraphs: [
          `We aim for the service to be available ${d.uptimeTargetPercent}% of each calendar month, not counting planned maintenance, which we announce at least 2 working days ahead and schedule outside UK working hours where we can. Availability depends on our hosting provider; we publish any incident and what we did about it.`,
        ],
      },
      {
        heading: "Fees and term",
        paragraphs: [
          "Fees are the plan price shown when you subscribe, paid in advance each period. The agreement runs while your subscription does and ends when either side ends it under the terms of service.",
        ],
      },
      {
        heading: "Your data at the end",
        paragraphs: [`After the agreement ends you can export your data for ${d.exitExportDays} days; then it is deleted as the privacy policy describes.`],
      },
      {
        heading: "Liability",
        paragraphs: [`As in the terms of service: limited to the fees paid in the ${d.liabilityCapMonths} months before the claim.`],
      },
    ],
  };
}
