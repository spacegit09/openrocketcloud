/*
 * Copy of OpenRocket 24.12's GeneralPreferencesPanel (GPL-3.0, (c) the OpenRocket team) for the
 * browser build, placed ahead of OpenRocket.jar on the class path. Changes, marked "orcloud": the
 * options that conflict with the browser version are left out (see below).
 */
package info.openrocket.swing.gui.dialogs.preferences;

import java.awt.event.ActionEvent;
import java.awt.event.ActionListener;
import java.awt.event.ItemEvent;
import java.awt.event.ItemListener;
import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

import javax.swing.JButton;
import javax.swing.JCheckBox;
import javax.swing.JComboBox;
import javax.swing.JFileChooser;
import javax.swing.JLabel;
import javax.swing.JOptionPane;
import javax.swing.JPanel;
import javax.swing.JSeparator;
import javax.swing.JTextField;
import javax.swing.SwingUtilities;
import javax.swing.event.DocumentEvent;
import javax.swing.event.DocumentListener;

import info.openrocket.swing.gui.util.UpdateInfoRunner;
import net.miginfocom.swing.MigLayout;

import info.openrocket.core.gui.util.SimpleFileFilter;
import info.openrocket.core.l10n.L10N;
import info.openrocket.core.logging.Markers;
import info.openrocket.core.preferences.ApplicationPreferences;
import info.openrocket.core.util.Named;
import info.openrocket.core.util.Utils;

import info.openrocket.swing.gui.components.DescriptionArea;
import info.openrocket.swing.gui.components.StyledLabel;
import info.openrocket.swing.gui.components.StyledLabel.Style;
import info.openrocket.swing.gui.util.GUIUtil;
import info.openrocket.swing.gui.util.SwingPreferences;
import info.openrocket.swing.gui.util.PreferencesExporter;
import info.openrocket.swing.gui.util.PreferencesImporter;


@SuppressWarnings("serial")
public class GeneralPreferencesPanel extends PreferencesPanel {

	public GeneralPreferencesPanel(PreferencesDialog parent) {
		super(parent, new MigLayout("fillx, ins 30lp n n n"));
		
		//// Language selector
		Locale userLocale;
		{
			String locale = preferences.getString("locale", null);
			userLocale = L10N.toLocale(locale);
		}
		List<Named<Locale>> locales = new ArrayList<>();
		for (Locale l : SwingPreferences.getSupportedLocales()) {
			locales.add(new Named<>(l, l.getDisplayLanguage(l) + "/" + l.getDisplayLanguage()));
		}
		Collections.sort(locales);
		locales.add(0, new Named<>(null, trans.get("generalprefs.languages.default")));
		
		final JComboBox<?> languageCombo = new JComboBox<>(locales.toArray());
		for (int i = 0; i < locales.size(); i++) {
			if (Utils.equals(userLocale, locales.get(i).get())) {
				languageCombo.setSelectedIndex(i);
			}
		}
		languageCombo.addActionListener(new ActionListener() {
			@Override
			@SuppressWarnings("unchecked")
			public void actionPerformed(ActionEvent e) {
				Named<Locale> selection = (Named<Locale>) languageCombo.getSelectedItem();
				if (selection == null) return;
				Locale l = selection.get();
				preferences.putString(ApplicationPreferences.USER_LOCAL, l == null ? null : l.toString());
			}
		});
		this.add(new JLabel(trans.get("generalprefs.lbl.language")), "gapright para");
		this.add(languageCombo, "wrap rel, growx, sg combos");
		
		this.add(new StyledLabel(trans.get("generalprefs.lbl.languageEffect"), -3, Style.ITALIC), "span, wrap rel");

		this.add(new JSeparator(JSeparator.HORIZONTAL), "spanx, growx, wrap para");

		// orcloud: user thrust curve and component preset folders, update checks and opening the
		// last design file are left out: the browser version shares motors through the dashboard,
		// opens the shared design and is updated with the site.


		//// Save RASAero Format warning dialog
		final JCheckBox rasaeroWarningDialogBox = new JCheckBox(trans.get("pref.dlg.lbl.RASAeroWarning"));
		rasaeroWarningDialogBox.setSelected(preferences.getShowRASAeroFormatWarning());
		rasaeroWarningDialogBox.addActionListener( new ActionListener() {
			@Override
			public void actionPerformed(ActionEvent e) {
				preferences.setShowRASAeroFormatWarning(rasaeroWarningDialogBox.isSelected());
			}
		});
		this.add(rasaeroWarningDialogBox,"spanx, wrap");
		
		//// Save RockSim Format warning dialog
		final JCheckBox rocksimWarningDialogBox = new JCheckBox(trans.get("pref.dlg.lbl.RockSimWarning"));
		rocksimWarningDialogBox.setSelected(preferences.getShowRockSimFormatWarning());
		rocksimWarningDialogBox.addActionListener( new ActionListener() {
			@Override
			public void actionPerformed(ActionEvent e) {
				preferences.setShowRockSimFormatWarning(rocksimWarningDialogBox.isSelected());
			}
		});
		this.add(rocksimWarningDialogBox,"spanx, wrap");

		//// Show confirmation dialog when discarding preferences
		final JCheckBox prefsDiscardBox = new JCheckBox(trans.get("pref.dlg.checkbox.ShowDiscardPreferencesConfirmation"));
		prefsDiscardBox.setSelected(preferences.isShowDiscardPreferencesConfirmation());
		prefsDiscardBox.addItemListener(new ItemListener() {
			@Override
			public void itemStateChanged(ItemEvent e) {
				preferences.setShowDiscardPreferencesConfirmation(e.getStateChange() == ItemEvent.SELECTED);
			}
		});
		this.add(prefsDiscardBox,"spanx, wrap");

		// orcloud: importing, exporting and resetting all preferences are left out (no files to
		// import from, and a reset would undo the browser's own settings).
	}
}
