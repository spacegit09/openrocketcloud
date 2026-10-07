package orcloud.bridge;

import java.time.LocalTime;
import java.time.format.DateTimeFormatter;

final class Log {
	private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm:ss.SSS");
	static volatile boolean debug = System.getenv("ORC_DEBUG") != null;

	private Log() {
	}

	static void info(String msg) {
		System.out.println(LocalTime.now().format(TIME) + " [liveshare] " + msg);
	}

	static void warn(String msg) {
		System.out.println(LocalTime.now().format(TIME) + " [liveshare] WARN " + msg);
	}

	static void debug(String msg) {
		if (debug) {
			info(msg);
		}
	}
}
