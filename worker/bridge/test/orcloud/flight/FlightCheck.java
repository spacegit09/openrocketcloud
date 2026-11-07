package orcloud.flight;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Enumeration;
import java.util.Locale;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.file.GeneralRocketLoader;
import info.openrocket.core.simulation.SimulationStatus;
import info.openrocket.core.simulation.exception.SimulationException;
import info.openrocket.core.simulation.listeners.AbstractSimulationListener;
import info.openrocket.core.util.Coordinate;

/**
 * Fixtures for checking the launch planner's flight engine against OpenRocket (web/test/flight.test.mjs):
 * for the first simulation of each example design bundled with OpenRocket, the flight tables
 * ({@link FlightTables}) and OpenRocket's results in three winds, given as a profile of air
 * velocity by height above the launch site: none, a steady wind, and one that strengthens and
 * turns with height. Run headless with OpenRocket's jar first on the class path:
 *
 * <pre>java -Djava.awt.headless=true -cp OpenRocket.jar:classes orcloud.flight.FlightCheck out-dir</pre>
 */
public final class FlightCheck {
	/** Wind profiles: rows of { height above the launch site (m), east, north (m/s, where the air goes) }. */
	static final double[][][] WINDS = {
			{ { 0, 0, 0 } },
			{ { 0, 6, 0 } }, // 6 m/s from the west
			{ { 0, 2, -1 }, { 300, 6, -2 }, { 1500, 10, 1 }, { 5000, 18, 6 }, { 15000, 30, 5 } },
	};

	private FlightCheck() {
	}

	/** Overrides OpenRocket's wind with a profile (linear between heights, constant beyond). */
	static final class ProfileWind extends AbstractSimulationListener {
		private final double[][] levels;

		ProfileWind(double[][] levels) {
			this.levels = levels;
		}

		@Override
		public Coordinate preWindModel(SimulationStatus status) throws SimulationException {
			double h = status.getRocketPosition().z;
			double u = levels[0][1];
			double v = levels[0][2];
			for (int i = 1; i < levels.length; i++) {
				if (h <= levels[i - 1][0]) {
					break;
				}
				double f = Math.min(1, (h - levels[i - 1][0]) / (levels[i][0] - levels[i - 1][0]));
				u = levels[i - 1][1] + f * (levels[i][1] - levels[i - 1][1]);
				v = levels[i - 1][2] + f * (levels[i][2] - levels[i - 1][2]);
			}
			// OpenRocket's wind vector points where the wind comes from.
			return new Coordinate(-u, -v, 0);
		}
	}

	public static void main(String[] args) throws Exception {
		Path out = Paths.get(args.length > 0 ? args[0] : "flight-fixtures");
		Files.createDirectories(out);
		Core.start();
		String jar = System.getProperty("java.class.path").split(java.io.File.pathSeparator)[0];
		String only = System.getenv("FLIGHT_ONLY");
		int done = 0;
		int skipped = 0;
		try (JarFile jf = new JarFile(jar)) {
			Enumeration<JarEntry> en = jf.entries();
			while (en.hasMoreElements()) {
				JarEntry e = en.nextElement();
				String name = e.getName();
				if (!name.startsWith("datafiles/examples/") || !name.endsWith(".ork")) {
					continue;
				}
				String example = name.substring("datafiles/examples/".length(), name.length() - 4);
				if (only != null && !example.contains(only)) {
					continue;
				}
				Path file = Files.createTempFile("example", ".ork");
				try (InputStream in = jf.getInputStream(e)) {
					Files.copy(in, file, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
				}
				OpenRocketDocument doc;
				try {
					doc = new GeneralRocketLoader(file.toFile()).load();
				} catch (Exception ex) {
					System.out.println("  skip " + example + ": " + ex);
					skipped++;
					continue;
				}
				if (doc.getSimulations().isEmpty()) {
					continue;
				}
				Simulation sim = doc.getSimulations().get(0);
				sim.getOptions().setLaunchIntoWind(false);
				long t0 = System.currentTimeMillis();
				String tables;
				try {
					tables = FlightTables.compute(sim, new ProfileWind(WINDS[0]));
				} catch (Exception ex) {
					System.out.println("  skip " + example + ": " + ex);
					skipped++;
					continue;
				}
				StringBuilder sb = new StringBuilder();
				sb.append("{\"example\":\"").append(example.replace("\"", "\\\"")).append("\",\"tables\":").append(tables)
						.append(",\"winds\":[");
				for (int w = 0; w < WINDS.length; w++) {
					sb.append(w == 0 ? "" : ",").append("{\"levels\":[");
					for (int i = 0; i < WINDS[w].length; i++) {
						double[] l = WINDS[w][i];
						sb.append(i == 0 ? "" : ",").append(String.format(Locale.ROOT, "[%s,%s,%s]", l[0], l[1], l[2]));
					}
					String result;
					try {
						result = FlightTables.run(sim, new ProfileWind(WINDS[w]));
					} catch (Exception ex) {
						result = "null";
					}
					sb.append("],\"openrocket\":").append(result).append('}');
				}
				sb.append("]}");
				Files.write(out.resolve(example.replaceAll("[^A-Za-z0-9._-]+", "_") + ".json"),
						sb.toString().getBytes(StandardCharsets.UTF_8));
				System.out.println(String.format(Locale.ROOT, "  %-55s %5d ms", example, System.currentTimeMillis() - t0));
				done++;
			}
		}
		System.out.println("FLIGHTCHECK " + done + " examples, " + skipped + " skipped");
		System.exit(0);
	}
}
