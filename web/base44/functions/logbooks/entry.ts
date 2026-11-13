// The signed-in person's flight logbooks: list, get, create, update, data sets, photos and videos,
// people, share, leave, delete (rules in shared/logbooks.js).
import { logbooksApi } from "../../shared/logbooks.js";
import { endpoint } from "../../shared/endpoint.ts";

export default endpoint("logbooks", logbooksApi);
