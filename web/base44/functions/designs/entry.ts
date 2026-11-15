// The signed-in person's designs: list, get, create, rename, share, leave, delete
// (rules in shared/api.js). Without a plan (shared/billing.js), people can still list their
// designs, open their listing (to download them), leave and delete them.
import { designsApi } from "../../shared/api.js";
import { OPEN_ACTIONS } from "../../shared/billing.js";
import { endpoint } from "../../shared/endpoint.ts";

export default endpoint("designs", designsApi, { open: OPEN_ACTIONS.designs });
