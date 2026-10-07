package orcloud.bridge;

import java.io.File;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.concurrent.TimeUnit;

import javax.swing.SwingUtilities;

import info.openrocket.swing.startup.SwingStartup;

/**
 * Starts the official OpenRocket application with live share attached.
 *
 * Environment: ORC_COLLAB_URL (ws://.../collab), ORC_TOKEN (session token issued by the
 * server), ORC_WORKDIR (where the shared design file is placed; default ~/Projects).
 */
public final class Main {
	private Main() {
	}

	public static void main(String[] args) throws Exception {
		String url = require("ORC_COLLAB_URL");
		String token = require("ORC_TOKEN");
		String wd = System.getenv("ORC_WORKDIR");
		Path workDir = Paths.get(wd != null && !wd.isEmpty() ? wd : System.getProperty("user.home") + "/Projects");
		Files.createDirectories(workDir);

		// What info.openrocket.swing.startup.OpenRocket.main does before handing over.
		System.setProperty("java.util.Arrays.useLegacyMergeSort", "true");
		OrDoc.installClasspathUrlHandler();
		OrDoc.configurePreferences(workDir);

		Bridge bridge = new Bridge(URI.create(url), token, workDir);
		bridge.start();
		Path file = bridge.awaitFile(120, TimeUnit.SECONDS);
		Log.info("Opening " + file);

		SwingStartup.main(new String[] { file.toString() });

		File f = file.toFile();
		SwingUtilities.invokeLater(() -> bridge.attach(f));
	}

	private static String require(String name) {
		String v = System.getenv(name);
		if (v == null || v.isEmpty()) {
			System.err.println("Missing environment variable " + name);
			System.exit(1);
		}
		return v;
	}
}
