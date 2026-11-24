// The signed-in person's motors from the motor designer: list, get, create, update, rename, delete
// (rules in shared/api.js). Without a plan (shared/billing.js), only list and delete. A tool for
// designing in OpenRocket, it comes with every plan, the OpenRocket plan included.
import { motorDesignsApi } from "../../shared/api.js";
import { OPEN_ACTIONS } from "../../shared/billing.js";
import { endpoint } from "../../shared/endpoint.ts";

export default endpoint("motorDesigns", motorDesignsApi, { open: OPEN_ACTIONS.motorDesigns });
