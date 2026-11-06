package orcloud.bridge;

import java.awt.Frame;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.prefs.Preferences;

import javax.swing.SwingUtilities;

import info.openrocket.core.arch.SystemInfo;
import info.openrocket.core.database.ComponentPresetDatabaseLoader;
import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.preferences.ApplicationPreferences;
import info.openrocket.swing.gui.main.BasicFrame;
import info.openrocket.swing.startup.SwingStartup;
import orcloud.web.ModelTab;
import orcloud.web.SettingsMenu;
import orcloud.web.StlImport;
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
			// The component preset database waited for the window (see our copy of its loader).
			ComponentPresetDatabaseLoader.loadNow();
			// Our additions to OpenRocket's menus: Settings (its preferences, before File) and Tools >
			// Import 3D model (STL); imported models are turned on the "3D model" tab of their Edit dialog.
			try {
				BasicFrame frame = OrDoc.findFrame(f);
				SettingsMenu.install(frame);
				OpenRocketDocument doc = OrDoc.documentOf(frame);
				StlImport.install(frame, doc, () -> {
					List<String> ids = OrDoc.selectedIds(frame);
					return ids.isEmpty() ? null : OrDoc.findComponent(doc, ids.get(0));
				});
				ModelTab.install(doc);
			} catch (Exception e) {
				Log.warn("3D model import unavailable: " + e);
			}
		});
	}

	private static void browserPreferences() throws Exception {
		Preferences openrocket = Preferences.userRoot().node("OpenRocket");
		// Save As and exports go straight to the user's downloads.
		openrocket.put("defaultDirectory", DOWNLOADS.toString());
		// The user's own component presets: OpenRocket's default folder, named explicitly. Left
		// unset, OpenRocket checks that folder with File.canRead(), which under CheerpJ can wrongly
		// fail off the UI thread, where the preset database now loads after start-up (see our copy
		// of its loader); the load then stops with a NullPointerException.
		File presets = new File(SystemInfo.getUserApplicationDirectory(), "Components");
		Files.createDirectories(presets.toPath());
		if (openrocket.get(ApplicationPreferences.USER_COMPONENT_PRESETS_KEY, null) == null) {
			openrocket.put(ApplicationPreferences.USER_COMPONENT_PRESETS_KEY, presets.getPath());
		}
		// Preferences the browser version leaves out (see our copies of its panels) stay off. Two slow
		// it down: "Update flight estimates in design window" (a background simulation that makes
		// every edit wait ~2 s under CheerpJ) and "Run out-dated simulations when you open the
		// simulation tab" (1-4 s per simulation). Two conflict with it: checking for OpenRocket
		// updates (the site is updated instead) and opening the last design file (the page opens
		// the shared design).
		openrocket.putBoolean("backgroundFlight", false);
		openrocket.putBoolean(ApplicationPreferences.AUTO_RUN_SIMULATIONS, false);
		openrocket.putBoolean("CheckUpdates", false);
		openrocket.putBoolean("CheckBetaUpdates", false);
		openrocket.putBoolean("AutoOpenLastDesign", false);
		openrocket.flush();
	}
}
