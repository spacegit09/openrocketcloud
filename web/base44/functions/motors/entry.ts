// The signed-in person's custom motor files: list, add, delete (rules in shared/api.js). Without
// a plan (shared/billing.js), only list and delete.
import { motorsApi } from "../../shared/api.js";
import { OPEN_ACTIONS } from "../../shared/billing.js";
import { endpoint } from "../../shared/endpoint.ts";

export default endpoint("motors", motorsApi, { open: OPEN_ACTIONS.motors });
