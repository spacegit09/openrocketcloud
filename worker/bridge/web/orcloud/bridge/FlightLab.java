package orcloud.bridge;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.util.Base64;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.nio.file.Files;
import java.nio.file.Path;

import javax.swing.SwingUtilities;

import com.google.inject.Guice;

import info.openrocket.core.plugin.PluginModule;
import info.openrocket.core.startup.Application;
import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.file.GeneralRocketLoader;
import info.openrocket.swing.startup.GuiModule;
import orcloud.flight.FlightTables;
import orcloud.stl.PartMeshes;
import orcloud.web.Preview;
import orcloud.web.Warmup;

/**
 * The launch planner's OpenRocket (web/src/flight/openrocket.js, through CheerpJ's library mode):
 * OpenRocket's core without its windows, the design's simulations, and the flight tables for one
 * of them ({@link FlightTables}). The page writes the design (.ork) and its custom motor files
 * under /str/ first. The dashboard uses it too, for the designs' previews ({@link Preview}).
 */
public final class FlightLab {
	private static boolean started;
	private static boolean prepared;
	private static String loadedPath;
	private static OpenRocketDocument loaded;

	private FlightLab() {
	}

	/**
	 * Starts OpenRocket's core once, with the custom motors named in `motors` ("|"-separated file
	 * names; the files are /str/planner-motor-NAME), set up as for a design session (see Bridge).
	 */
	private static synchronized void start(String motors) throws Exception {
		if (started) {
			return;
		}
		if (!prepared) {
			System.setProperty("java.util.Arrays.useLegacyMergeSort", "true");
			Warmup.xml();
			OrDoc.installClasspathUrlHandler(); // once per page: Java allows one
			prepared = true;
		}
		Path work = Path.of("/files/orcloud/planner");
		Files.createDirectories(work);
		Path dir = OrDoc.motorDir();
		Files.createDirectories(dir);
		try (var old = Files.list(dir)) {
			for (Path f : (Iterable<Path>) old::iterator) {
				Files.deleteIfExists(f);
			}
		}
		if (motors != null) {
			for (String name : motors.split("\\|")) {
				String safe = name.replaceAll("[^A-Za-z0-9._-]", "_");
				if (!safe.matches("(?i).*\\.(eng|rse)")) {
					continue;
				}
				// CheerpJ's /str/ files sit at the top level (no folders there); bytes as they came.
				try {
					Files.write(dir.resolve(safe), Files.readAllBytes(Path.of("/str/planner-motor-" + safe)));
				} catch (Exception e) {
					Log.warn("Skipping custom motor " + safe + ": " + e);
				}
			}
		}
		OrDoc.configurePreferences(work);
		// OpenRocket's services as its desktop start-up sets them up (SwingStartup), which is what
		// the design page runs under CheerpJ every day; its headless core start-up failed at random
		// there. No window is opened.
		GuiModule gui = new GuiModule();
		Application.setInjector(Guice.createInjector(gui, new PluginModule()));
		gui.startLoader();
		started = true;
	}

	private static OpenRocketDocument load(String path) throws Exception {
		if (!path.equals(loadedPath)) {
			loaded = new GeneralRocketLoader(new File(path)).load();
			loadedPath = path;
		}
		return loaded;
	}

	/** The design's simulations: [{ name, configuration }], or { error }. */
	public static String simulations(String path, String motors) {
		try {
			start(motors);
			loadedPath = null;
			OpenRocketDocument doc = load(path);
			StringBuilder sb = new StringBuilder("[");
			for (int i = 0; i < doc.getSimulations().size(); i++) {
				Simulation s = doc.getSimulations().get(i);
				sb.append(i == 0 ? "" : ",").append("{\"name\":").append(quote(s.getName())).append(",\"configuration\":")
						.append(quote(s.getActiveConfiguration().getName())).append('}');
			}
			return sb.append(']').toString();
		} catch (Throwable e) {
			Log.warn("Could not read the design: " + e);
			e.printStackTrace();
			return "{\"error\":" + quote(String.valueOf(e.getMessage() != null ? e.getMessage() : e)) + "}";
		}
	}

	/** The design's preview (see orcloud.web.Preview), or { error }. */
	public static String preview(String path, String motors) {
		try {
			start(motors);
			OpenRocketDocument doc = new GeneralRocketLoader(new File(path)).load();
			adoptModels(path);
			String[] out = new String[1];
			Exception[] failed = new Exception[1];
			SwingUtilities.invokeAndWait(() -> {
				try {
					out[0] = Preview.of(doc.getRocket());
				} catch (Exception e) {
					failed[0] = e;
				}
			});
			if (failed[0] != null) {
				throw failed[0];
			}
			return out[0] != null ? out[0] : "{\"error\":\"The drawing is too large.\"}";
		} catch (Throwable e) {
			Log.warn("Could not draw the design: " + e);
			return "{\"error\":" + quote(String.valueOf(e.getMessage() != null ? e.getMessage() : e)) + "}";
		}
	}

	/**
	 * Registers the shapes of imported 3D models kept in the design's file (orcloud.stl.PartMeshes),
	 * so parts made from them are drawn as the models, as on the design page.
	 */
	private static void adoptModels(String path) throws IOException {
		try (ZipInputStream zip = new ZipInputStream(new FileInputStream(path))) {
			for (ZipEntry e; (e = zip.getNextEntry()) != null;) {
				String id = PartMeshes.componentId(e.getName());
				if (id != null) {
					PartMeshes.adopt(id, Base64.getEncoder().encodeToString(zip.readAllBytes()));
				}
			}
		}
	}

	/** The flight tables for the design's simulation `index`, or { error }. */
	public static String tables(String path, int index) {
		try {
			OpenRocketDocument doc = load(path);
			return FlightTables.compute(doc.getSimulations().get(index));
		} catch (Throwable e) {
			Log.warn("Could not compute flight tables: " + e);
			e.printStackTrace();
			return "{\"error\":" + quote(String.valueOf(e.getMessage() != null ? e.getMessage() : e)) + "}";
		}
	}

	private static String quote(String s) {
		return s == null ? "null"
				: "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replaceAll("[\\x00-\\x1f]", " ") + "\"";
	}
}
