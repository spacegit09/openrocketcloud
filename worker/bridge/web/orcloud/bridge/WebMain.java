package orcloud.bridge;

import java.awt.Frame;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import java.util.prefs.Preferences;

import javax.swing.SwingUtilities;

import info.openrocket.swing.startup.SwingStartup;
import orcloud.web.Warmup;

/**
 * Browser (CheerpJ) entry point: starts the official OpenRocket with live share attached, like
 * {@link Main} does in the server's session containers. The page passes the design id as the
 * system property orcloud.design.
 */
public final class WebMain {
	/** Files Java writes here are downloaded to the user's computer (CheerpJ 4.3+). */
	private static final Path DOWNLOADS = Path.of("/files/downloads");

	private WebMain() {
	}

	public static void main(String[] args) throws Exception {
		String design = System.getProperty("orcloud.design", "design").replaceAll("[^A-Za-z0-9_-]", "_");
		Path workDir = Path.of("/files/orcloud", design);
		Files.createDirectories(workDir);
		Files.createDirectories(DOWNLOADS);

		// What info.openrocket.swing.startup.OpenRocket.main does before handing over.
		System.setProperty("java.util.Arrays.useLegacyMergeSort", "true");
		// Under CheerpJ, Java's XML machinery fails at random when two threads set it up at once.
		Warmup.xml();
		OrDoc.installClasspathUrlHandler();
		OrDoc.configurePreferences(workDir);
		browserPreferences();

		Bridge bridge = new Bridge(BrowserLink::new, "", workDir);
		bridge.start();
		Path file = bridge.awaitFile(180, TimeUnit.SECONDS);
		Log.info("Opening " + file);

		SwingStartup.main(new String[] { file.toString() });

		File f = file.toFile();
		SwingUtilities.invokeLater(() -> {
			bridge.attach(f);
			for (Frame frame : Frame.getFrames()) {
				if (frame.isVisible()) {
					frame.setExtendedState(Frame.MAXIMIZED_BOTH);
				}
			}
			BrowserLink.ready();
		});
	}

	private static void browserPreferences() throws Exception {
		Preferences openrocket = Preferences.userRoot().node("OpenRocket");
		// Save As and exports go straight to the user's downloads.
		openrocket.put("defaultDirectory", DOWNLOADS.toString());
		// Once per browser: "Update flight estimates in design window" (Preferences > Design) off.
		// Its background simulation makes every edit wait ~2 s under CheerpJ; anyone who turns it
		// back on keeps that choice.
		Preferences web = Preferences.userRoot().node("orcloud-web");
		if (!web.getBoolean("browserDefaultsApplied", false)) {
			openrocket.putBoolean("backgroundFlight", false);
			web.putBoolean("browserDefaultsApplied", true);
		}
		openrocket.flush();
	}
}
