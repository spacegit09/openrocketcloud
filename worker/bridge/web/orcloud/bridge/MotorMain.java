package orcloud.bridge;

import java.io.OutputStream;
import java.io.PrintStream;
import java.util.Map;

/**
 * The motor designer's calculator as a program (cheerpjRunMain), the way the launch planner runs
 * OpenRocket ({@link FlightMain}): it answers the page's requests one at a time ({@link MotorLab}).
 * Requests and replies are JSON, through the natives in web/src/motor/natives.js:
 * { id, op: "simulate", motor } and { id, op: "areas", motor }.
 */
public final class MotorMain {
	private MotorMain() {
	}

	/** Waits for the page's next request. */
	private static native String jsNext();

	private static native void jsReply(double id, String json);

	@SuppressWarnings("unchecked")
	public static void main(String[] args) {
		// JSRM writes a warning to the standard output for each step of a complex grain shape (star,
		// finocyl...), thousands per motor: in the browser, each would be a line in the console.
		System.setOut(new PrintStream(OutputStream.nullOutputStream()));
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
				Map<String, Object> motor = (Map<String, Object>) req.get("motor");
				switch (String.valueOf(req.get("op"))) {
				case "simulate":
					out = MotorLab.simulate(motor);
					break;
				case "areas":
					out = MotorLab.areas(motor);
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
