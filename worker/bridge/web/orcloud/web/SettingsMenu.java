package orcloud.web;

import javax.swing.JMenu;
import javax.swing.JMenuBar;
import javax.swing.JMenuItem;

import info.openrocket.core.l10n.Translator;
import info.openrocket.core.startup.Application;
import info.openrocket.swing.gui.dialogs.preferences.PreferencesDialog;
import info.openrocket.swing.gui.main.BasicFrame;

/**
 * A "Settings" menu before OpenRocket's File menu (browser version): one item per page of
 * OpenRocket's preferences, opening that page. The pages are those of our copy of PreferencesDialog,
 * without the options that conflict with the browser version or slow it down.
 */
public final class SettingsMenu {
	/** The preferences pages, in our PreferencesDialog's tab order, by OpenRocket's names. */
	private static final String[] PAGES = { "pref.dlg.tab.General", "pref.dlg.tab.UI", "pref.dlg.tab.Design",
			"pref.dlg.tab.Simulation", "pref.dlg.tab.Launch", "pref.dlg.tab.Units", "pref.dlg.tab.Materials" };

	private SettingsMenu() {
	}

	public static void install(BasicFrame frame) {
		Translator trans = Application.getTranslator();
		JMenu menu = new JMenu("Settings");
		for (int i = 0; i < PAGES.length; i++) {
			int tab = i;
			JMenuItem item = new JMenuItem(trans.get(PAGES[i]) + "...");
			item.addActionListener(e -> PreferencesDialog.showPreferences(frame, tab));
			menu.add(item);
		}
		JMenuBar bar = frame.getJMenuBar();
		bar.add(menu, 0);
		bar.revalidate();
	}
}
