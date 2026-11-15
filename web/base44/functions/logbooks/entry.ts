// The signed-in person's flight logbooks: list, get, create, update, data sets, photos and videos,
// people, share, leave, delete (rules in shared/logbooks.js). Without a plan
// (shared/billing.js), only list, leave and delete.
import { logbooksApi } from "../../shared/logbooks.js";
import { OPEN_ACTIONS } from "../../shared/billing.js";
import { endpoint } from "../../shared/endpoint.ts";

export default endpoint("logbooks", logbooksApi, { open: OPEN_ACTIONS.logbooks });
