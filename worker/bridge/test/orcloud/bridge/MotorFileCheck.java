package orcloud.bridge;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;

import info.openrocket.core.file.motor.GeneralMotorLoader;
import info.openrocket.core.motor.ThrustCurveMotor;

/**
 * Loads each motor file in a folder (worker/bridge/test/motors) as a session does: decoded as the
 * site decodes uploads, tidied (OrDoc.tidyMotorFile), written as UTF-8, and read with OpenRocket's
 * own motor readers, each motor then built as its motor database builds it. Writes, for
 * server/test/motors.test.js to compare with the site's upload check:
 *   verdicts.txt   name TAB "ok" TAB number-of-motors, or name TAB "error" TAB message
 *   NAME.tidy      the tidied text
 *
 *   java -cp OpenRocket.jar:classes orcloud.bridge.MotorFileCheck <motor folder> <out folder>
 */
public final class MotorFileCheck {
	private MotorFileCheck() {
	}

	public static void main(String[] args) throws Exception {
		Path in = Path.of(args[0]);
		Path out = Path.of(args[1]);
		Files.createDirectories(out);
		List<String> verdicts = new ArrayList<>();
		int ok = 0;
		int refused = 0;
		List<Path> files;
		try (Stream<Path> s = Files.list(in)) {
			files = s.filter(p -> p.getFileName().toString().matches("(?i).*\\.(eng|rse)")).sorted().toList();
		}
		for (Path f : files) {
			String name = f.getFileName().toString();
			// TextDecoder in the dashboard: malformed UTF-8 becomes U+FFFD, as here.
			String text = new String(Files.readAllBytes(f), StandardCharsets.UTF_8);
			String tidied = OrDoc.tidyMotorFile(name, text);
			Files.writeString(out.resolve(name + ".tidy"), tidied, StandardCharsets.UTF_8);
			String verdict;
			try {
				List<ThrustCurveMotor.Builder> builders = new GeneralMotorLoader()
						.load(new ByteArrayInputStream(tidied.getBytes(StandardCharsets.UTF_8)), name);
				for (ThrustCurveMotor.Builder b : builders) {
					b.build();
				}
				verdict = builders.isEmpty() ? "error\tno motors" : "ok\t" + builders.size();
			} catch (Throwable t) {
				verdict = "error\t" + String.valueOf(t.getMessage()).replaceAll("\\s+", " ");
			}
			if (verdict.startsWith("ok")) {
				ok++;
			} else {
				refused++;
			}
			verdicts.add(name + "\t" + verdict);
		}
		Files.write(out.resolve("verdicts.txt"), verdicts, StandardCharsets.UTF_8);
		System.out.println("MOTORFILECHECK " + files.size() + " files: OpenRocket loads " + ok + ", refuses " + refused
				+ " (verdicts in " + out.resolve("verdicts.txt") + ")");
	}
}
