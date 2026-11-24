// The signed-in person's motors from the motor designer: list, get, create, update, rename, delete
// (rules in shared/api.js). Without a plan (shared/billing.js), only list and delete. Like the
// Launch Planner and the Logbook, it is not part of the plan for OpenRocket only (full).
import { motorDesignsApi } from "../../shared/api.js";
import { OPEN_ACTIONS } from "../../shared/billing.js";
import { endpoint } from "../../shared/endpoint.ts";

export default endpoint("motorDesigns", motorDesignsApi, { open: OPEN_ACTIONS.motorDesigns, full: true });
