package orcloud.bridge;

import java.awt.AWTEvent;
import java.awt.Frame;
import java.awt.Toolkit;
import java.awt.event.AWTEventListener;
import java.awt.event.ContainerEvent;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.prefs.Preferences;

import javax.swing.JMenuBar;
import javax.swing.SwingUtilities;

import info.openrocket.core.arch.SystemInfo;
import info.openrocket.core.database.ComponentPresetDatabaseLoader;
import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.preferences.ApplicationPreferences;
import info.openrocket.swing.gui.main.BasicFrame;
import info.openrocket.swing.startup.SwingStartup;
import orcloud.web.CommandClick;
import orcloud.web.FileWindows;
import orcloud.web.FinProfiles;
import orcloud.web.MenuRow;
import orcloud.web.ModelTab;
import orcloud.web.Preview;
import orcloud.web.RecoveryHelpers;
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
		// On a Mac, ⌘-click adds to a selection (the component tree, lists, tables).
		CommandClick.install();

		Bridge bridge = new Bridge(BrowserLink::new, "", workDir);
		bridge.start();
		Path file = bridge.awaitFile(180, TimeUnit.SECONDS);
		Log.info("Opening " + file);

		// OpenRocket's window is set up for the page as OpenRocket makes it, before it is first drawn,
		// so it is drawn once, at its final size (under CheerpJ each redraw of the whole window takes a
		// second or more, and once live share is attached, loading the component presets holds up
		// redrawing for several more):
		// - No title bar: the page around it shows the design's name and has the Close button. A frame
		//   can drop its title bar only before it has a native window, so it drops it as its root
		//   pane goes in.
		// - Maximized: OpenRocket remembers that (set in browserPreferences).
		// - Our menu additions, with the menus in the page's header row, as its menu bar goes in.
		AWTEventListener setUp = e -> {
			if (e.getID() != ContainerEvent.COMPONENT_ADDED) {
				return;
			}
			ContainerEvent c = (ContainerEvent) e;
			if (c.getContainer() instanceof BasicFrame) {
				BasicFrame frame = (BasicFrame) c.getContainer();
				if (!frame.isDisplayable() && !frame.isUndecorated()) {
					frame.setUndecorated(true);
				}
			} else if (c.getChild() instanceof JMenuBar && withMenus == null) {
				BasicFrame frame = (BasicFrame) SwingUtilities.getAncestorOfClass(BasicFrame.class, c.getContainer());
				if (frame != null && frame.getJMenuBar() == c.getChild()) {
					addMenus(frame);
				}
			}
		};
		Toolkit.getDefaultToolkit().addAWTEventListener(setUp, AWTEvent.CONTAINER_EVENT_MASK);
		SwingStartup.main(new String[] { file.toString() });

		File f = file.toFile();
		SwingUtilities.invokeLater(() -> {
			// Windows opened later (a second design, say) keep the usual title bar.
			Toolkit.getDefaultToolkit().removeAWTEventListener(setUp);
			boolean reopened = false;
			for (Frame frame : Frame.getFrames()) {
				if (frame.isVisible()) {
					if (!frame.isUndecorated()) {
						// Shown with a title bar after all: reopened without one.
						frame.dispose();
						frame.setUndecorated(true);
						frame.setVisible(true);
						reopened = true;
					}
					if (frame.getExtendedState() != Frame.MAXIMIZED_BOTH) {
						frame.setExtendedState(Frame.MAXIMIZED_BOTH);
					}
				}
			}
			// OpenRocket ends a session in its own close action, not on the "window closed" event that
			// reopening posts, but the bridge would, so then it attaches after that event.
			if (reopened) {
				SwingUtilities.invokeLater(() -> attach(bridge, f));
			} else {
				attach(bridge, f);
			}
		});
	}

	/** The window our menu additions are in. */
	private static BasicFrame withMenus;

	/**
	 * Our additions to OpenRocket's menus: Settings (its preferences, before File), and the menus
	 * moved into the page's header row.
	 */
	private static void addMenus(BasicFrame frame) {
		withMenus = frame;
		try {
			SettingsMenu.install(frame);
			MenuRow.install(frame);
		} catch (Exception e) {
			Log.warn("Menu additions unavailable: " + e);
		}
	}

	/** Live share and the rest of our additions; then the page shows the window. */
	private static void attach(Bridge bridge, File f) {
		bridge.attach(f);
		BasicFrame frame = OrDoc.findFrame(f);
		if (frame != null && withMenus != frame) {
			addMenus(frame);
		}
		// The page shows the window, and its header may have changed since the menus were placed.
		MenuRow.placeNow(BrowserLink.ready());
		// Once the menu bar is redrawn: the header shows the menus, and the component preset database,
		// which waited for the window (see our copy of its loader), loads. Loading holds up redrawing
		// for several seconds.
		SwingUtilities.invokeLater(() -> {
			MenuRow.show();
			ComponentPresetDatabaseLoader.loadNow();
		});
		FileWindows.install();
		// Tools > Import 3D model (STL); imported models are turned on the "3D model" tab of their
		// Edit dialog.
		try {
			OpenRocketDocument doc = OrDoc.documentOf(frame);
			StlImport.install(frame, doc, () -> {
				List<String> ids = OrDoc.selectedIds(frame);
				return ids.isEmpty() ? null : OrDoc.findComponent(doc, ids.get(0));
			});
			ModelTab.install(doc);
		} catch (Exception e) {
			Log.warn("3D model import unavailable: " + e);
		}
		// Tools > Recovery (parachute size, ejection charge and shear pins) and Tools > Ballast (nose weight).
		try {
			RecoveryHelpers.install(frame, OrDoc.documentOf(frame));
		} catch (Exception e) {
			Log.warn("Recovery helpers unavailable: " + e);
		}
		// Fin cross sections in 3D (OBJ) export, chosen in its options.
		FinProfiles.install();
		// The design's preview for its card on the dashboard.
		try {
			Preview.install(OrDoc.documentOf(frame));
		} catch (Exception e) {
			Log.warn("Design preview unavailable: " + e);
		}
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
		// OpenRocket's window opens maximized (it remembers this per window class, as "max").
		openrocket.node("windows").put("size." + BasicFrame.class.getCanonicalName(), "max");
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
		// Rocket dimensions in millimetres (OpenRocket's own default is centimetres): set once per
		// browser, unless another unit than cm was already chosen; later choices are kept.
		Preferences web = Preferences.userRoot().node("orcloud-web");
		if (!web.getBoolean("lengthsInMm", false)) {
			Preferences units = openrocket.node("units");
			String length = units.get("LENGTH", null);
			if (length == null || length.equals("cm")) {
				units.put("LENGTH", "mm");
			}
			web.putBoolean("lengthsInMm", true);
		}
		openrocket.flush();
	}
}
