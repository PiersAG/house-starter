// The actions this app counts for billing and analytics (app-business-core issue 808,
// Matt Murphy #258: "every billable action gets an event user acts performed action Y
// at time stamp Z store these events in a dedicated table").
//
// Each entry is one action a customer performs that the app may one day charge for,
// or wants to measure the value it gives: "report.generated", "client.invited". The
// app records it with lib/usage/billable-events.ts recordBillableEvent at the point
// the action succeeds. An action not listed here is refused, so the table only ever
// holds actions someone chose to count.
//
// The template counts nothing: a per-app build adds the app's own actions. Whether
// an app CHARGES per action (credits, metered pricing) is a pricing decision
// (app-business-core issues 379 and 808); the events are recorded from the first
// day either way, because they cannot be reconstructed later.

export const BILLABLE_ACTIONS: readonly string[] = [];
