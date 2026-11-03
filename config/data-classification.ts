// Data classification — every column of every table, and how far it may travel
// (app-business-core issue 445 SEC.28, ASVS V8.1/V8.3; Matt Murphy #31).
//
// Four classes:
//   public    — fine for anyone to see (the settings registry's own text).
//   personal  — the customer's own data: shown to the account it belongs to,
//               never to another.
//   internal  — server bookkeeping (database addresses, payment-provider ids,
//               logs, counters, revocation lists): never sent to a browser.
//   secret    — credential material: stored only hashed or sealed, never sent
//               to a browser, never logged.
//
// What holds it:
//   * tests/unit/data-classification.test.ts — every column in lib/schema.ts is
//     listed here exactly once (a new column fails until it is classified), and
//     every secret column's storage is checked against the code that writes it;
//   * tests/unit/data-boundary.test.ts — no response body and no client
//     component's props carries an internal or secret field, or a whole row;
//   * tests/e2e/payload-audit.spec.ts — the real pages (their React Server
//     Components payload) and API answers, signed in, carry none of them.
//
// A builder adding a table adds its columns here in the same change.

export type DataClass = "public" | "personal" | "internal" | "secret";

/** How a secret column is kept at rest. */
export type SecretStorage = "bcrypt" | "sha256" | "sealed";

export type ColumnClass =
  | { class: "public" | "personal" | "internal" }
  | { class: "secret"; storedAs: SecretStorage; writer: string };

const pub = { class: "public" } as const;
const own = { class: "personal" } as const;
const internal = { class: "internal" } as const;

/** Keyed by the table's export name in lib/schema.ts, then the column's property name. */
export const DATA_CLASSIFICATION: Record<string, Record<string, ColumnClass>> = {
  tenants: {
    id: internal,
    dbUrl: internal,
    dbAuthToken: { class: "secret", storedAs: "sealed", writer: "lib/tenant/provisioner.ts" },
    provisioner: internal,
    label: internal,
    createdAt: internal,
  },
  users: {
    id: own,
    email: own,
    passwordHash: { class: "secret", storedAs: "bcrypt", writer: "lib/users.ts" },
    name: own,
    tenantId: own,
    role: own,
    createdAt: own,
    sessionsValidFrom: internal,
    deactivatedAt: internal,
    deletionDueAt: own,
    signupPendingSince: internal,
    signupTenantId: internal,
  },
  revokedSessions: { id: internal, jti: internal, userId: internal, revokedAt: internal },
  subscriptions: {
    id: internal,
    userId: internal,
    stripeCustomerId: internal,
    stripeSubscriptionId: internal,
    status: own,
    priceId: internal,
    currentPeriodEnd: own,
    trialEndsAt: own,
    pastDueAt: own,
    createdAt: internal,
    updatedAt: internal,
  },
  stripeEvents: { id: internal, processedAt: internal, status: internal, claimedAt: internal },
  billingInvoices: {
    stripeInvoiceId: internal,
    stripeCustomerId: internal,
    userId: internal,
    status: own,
    amountPaid: own,
    amountDue: own,
    currency: own,
    attemptCount: internal,
    hostedInvoiceUrl: own,
    paidAt: own,
    lastFailedAt: own,
    dunningEmailsSent: internal,
    receiptSentAt: internal,
    updatedAt: internal,
  },
  billingDisputes: {
    stripeDisputeId: internal,
    stripeChargeId: internal,
    stripeCustomerId: internal,
    amount: internal,
    currency: internal,
    reason: internal,
    status: internal,
    evidenceDueBy: internal,
    openedAt: internal,
    closedAt: internal,
    updatedAt: internal,
  },
  passwordResetTokens: {
    id: internal,
    userId: internal,
    tokenHash: { class: "secret", storedAs: "sha256", writer: "lib/password-reset.ts" },
    expiresAt: internal,
    usedAt: internal,
    createdAt: internal,
  },
  settingDefinitions: {
    key: pub,
    capability: pub,
    functionalGroup: pub,
    label: pub,
    description: pub,
    valueType: pub,
    enumValues: pub,
    factoryDefault: pub,
    bounds: pub,
    ownerEditable: pub,
    clientScoped: pub,
    requiresFlag: internal,
    operatorOnly: internal,
  },
  settingValues: {
    key: own,
    scope: own,
    clientId: internal,
    value: own,
    version: own,
    updatedAt: own,
  },
  operatorSettingValues: { key: internal, value: internal, updatedAt: internal },
  errorEvents: {
    id: internal,
    occurredAt: internal,
    message: internal,
    stack: internal,
    route: internal,
    method: internal,
    digest: internal,
    context: internal,
    requestId: internal,
    level: internal,
  },
  // S12 (issues 503, 796, 806): server records about requests and actions.
  // Ids and event names only; never shown to a browser.
  logEvents: {
    id: internal,
    occurredAt: internal,
    level: internal,
    event: internal,
    requestId: internal,
    route: internal,
    method: internal,
    status: internal,
    durationMs: internal,
    userId: internal,
    tenantId: internal,
    action: internal,
    fields: internal,
  },
  auditEvents: {
    id: internal,
    occurredAt: internal,
    action: internal,
    actor: internal,
    subjectUserId: internal,
    tenantId: internal,
    target: internal,
    before: internal,
    after: internal,
    requestId: internal,
  },
  tenantAccessEvents: {
    id: internal,
    occurredAt: internal,
    tenantId: internal,
    sessionTenantId: internal,
    userId: internal,
    requestId: internal,
    route: internal,
    crossTenant: internal,
  },
  credentialEvents: {
    id: internal,
    occurredAt: internal,
    event: internal,
    credential: internal,
    tenantId: internal,
    service: internal,
    access: internal,
    ip: internal,
    expiresAt: internal,
  },
  accessGrants: {
    id: internal,
    userId: internal,
    type: internal,
    note: internal,
    grantedBy: internal,
    grantedAt: internal,
    expiresAt: internal,
  },
  userMfaTotp: {
    id: internal,
    userId: internal,
    secretCiphertext: { class: "secret", storedAs: "sealed", writer: "lib/mfa/enrollment.ts" },
    secretIv: { class: "secret", storedAs: "sealed", writer: "lib/mfa/enrollment.ts" },
    secretTag: { class: "secret", storedAs: "sealed", writer: "lib/mfa/enrollment.ts" },
    confirmedAt: own,
    lastUsedStep: internal,
    failedAttempts: internal,
    createdAt: internal,
  },
  userMfaRecoveryCodes: {
    id: internal,
    userId: internal,
    codeHash: { class: "secret", storedAs: "sha256", writer: "lib/mfa/recovery-codes.ts" },
    usedAt: internal,
    createdAt: internal,
  },
  tenantMeta: { id: internal, tenantId: own, label: own, createdAt: own },
  recordEvents: {
    id: internal,
    entity: internal,
    entityKey: internal,
    version: internal,
    action: internal,
    data: internal,
    actor: internal,
    occurredAt: internal,
  },
  // Account deletion and retention (issues 722, 745, 791): server records only.
  retainedRecords: {
    id: internal,
    sourceTable: internal,
    recordKey: internal,
    subjectUserId: internal,
    data: internal,
    legalBasis: internal,
    clockStartedAt: internal,
    expiresAt: internal,
  },
  erasures: { userId: internal, tenantId: internal, requestedAt: internal, erasedAt: internal },
  // Issues 358, 857: databases waiting for the factory's sweep. Ids only.
  tenantOrphans: { tenantId: internal, reason: internal, recordedAt: internal, clearedAt: internal },
  // Issue 757: the email provider's delivery reports. No address or content.
  emailEvents: { id: internal, receivedAt: internal, type: internal, messageId: internal, bounceKind: internal },
};
