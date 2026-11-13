// The signed-in person's custom motor files: list, add, delete (rules in shared/api.js).
import { motorsApi } from "../../shared/api.js";
import { endpoint } from "../../shared/endpoint.ts";

export default endpoint("motors", motorsApi);
