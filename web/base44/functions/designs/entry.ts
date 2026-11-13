// The signed-in person's designs: list, get, create, rename, share, leave, delete
// (rules in shared/api.js).
import { designsApi } from "../../shared/api.js";
import { endpoint } from "../../shared/endpoint.ts";

export default endpoint("designs", designsApi);
