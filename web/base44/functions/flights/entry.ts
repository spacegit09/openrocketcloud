// The signed-in person's saved launch plans: list, get, create, update, rename, delete (rules in
// shared/api.js).
import { flightsApi } from "../../shared/api.js";
import { endpoint } from "../../shared/endpoint.ts";

export default endpoint("flights", flightsApi);
