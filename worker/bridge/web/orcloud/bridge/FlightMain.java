package orcloud.bridge;

import java.util.Map;

/**
 * The launch planner's OpenRocket as a program (cheerpjRunMain), the way the design page runs
 * OpenRocket: it answers the page's requests one at a time ({@link FlightLab}). Requests and
 * replies are JSON, through the natives in web/src/flight/lab-natives.js: { id, op: "simulations",
 * path, motors } and { id, op: "tables", path, index }. (CheerpJ's library mode, calling Java from
 * the page directly, failed at random while OpenRocket started.)
 */
public final class FlightMain {
	private FlightMain() {
	}

	/** Waits for the page's next request. */
	private static native String jsNext();

	private static native void jsReply(double id, String json);

	@SuppressWarnings("unchecked")
	public static void main(String[] args) {
		while (true) {
			String text = jsNext();
			if (text == null || text.isEmpty()) {
				continue;
			}
			double id = -1;
			String out;
			try {
				Map<String, Object> req = (Map<String, Object>) Json.parse(text);
				id = ((Number) req.get("id")).doubleValue();
				String path = String.valueOf(req.get("path"));
				switch (String.valueOf(req.get("op"))) {
				case "simulations":
					out = FlightLab.simulations(path, (String) req.get("motors"));
					break;
				case "tables":
					out = FlightLab.tables(path, ((Number) req.get("index")).intValue());
					break;
				default:
					out = "{\"error\":\"Unknown request.\"}";
				}
			} catch (Throwable e) {
				out = "{\"error\":\"Bad request.\"}";
			}
			jsReply(id, out);
		}
	}
}
