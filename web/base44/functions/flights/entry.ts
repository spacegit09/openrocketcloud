// The signed-in person's saved launch plans: list, get, create, update, rename, delete (rules in
// shared/api.js). Without a plan (shared/billing.js), only list and delete.
import { flightsApi } from "../../shared/api.js";
import { OPEN_ACTIONS } from "../../shared/billing.js";
import { endpoint } from "../../shared/endpoint.ts";

export default endpoint("flights", flightsApi, { open: OPEN_ACTIONS.flights });
