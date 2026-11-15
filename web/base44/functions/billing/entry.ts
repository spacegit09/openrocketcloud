// The signed-in person's plan: status (and the start of their free week), checkout (a Paddle
// transaction for the plan they chose), sync (a purchase just paid for), members (of their group),
// cancel and resume (their monthly plan), portal (Paddle's page for their payment details and
// receipts). Rules in shared/billing.js.
import { billingApi } from "../../shared/billing.js";
import { endpoint } from "../../shared/endpoint.ts";

export default endpoint("billing", billingApi);
