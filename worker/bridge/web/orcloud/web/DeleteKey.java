package orcloud.web;

import java.awt.Component;
import java.awt.KeyboardFocusManager;
import java.awt.Window;
import java.awt.event.InputEvent;
import java.awt.event.KeyEvent;

import javax.swing.JComboBox;
import javax.swing.JSpinner;
import javax.swing.JTable;
import javax.swing.SwingUtilities;
import javax.swing.text.JTextComponent;

import info.openrocket.swing.gui.main.BasicFrame;
import info.openrocket.swing.gui.main.SimulationPanel;
import info.openrocket.swing.gui.main.flightconfigpanel.FlightConfigurablePanel;

/**
 * The delete key of a Mac or a Chromebook (Backspace, to Java) deletes the selected parts or
 * simulations, as OpenRocket's Delete key does. Their keyboards have no Delete key (only fn + delete,
 * or Search + Backspace), so nothing deleted them from the keyboard. ⌘ + delete too, as in the
 * Finder. Only in OpenRocket's window, and never while typing: not in a text field, a number field
 * or a drop-down, and not in the tables of the Motors & Configuration tab.
 */
public final class DeleteKey {
	private DeleteKey() {
	}

	public static void install() {
		KeyboardFocusManager.getCurrentKeyboardFocusManager().addKeyEventDispatcher(e -> {
			if (e.getID() != KeyEvent.KEY_PRESSED || e.getKeyCode() != KeyEvent.VK_BACK_SPACE
					|| (e.getModifiersEx() & ~InputEvent.META_DOWN_MASK) != 0 || !deletes(e.getComponent())) {
				return false;
			}
			// What the Delete key does there (OpenRocket's Edit > Delete).
			KeyEvent delete = new KeyEvent(e.getComponent(), KeyEvent.KEY_PRESSED, e.getWhen(), 0, KeyEvent.VK_DELETE,
					KeyEvent.CHAR_UNDEFINED);
			KeyboardFocusManager.getCurrentKeyboardFocusManager().redispatchEvent(e.getComponent(), delete);
			return true;
		});
	}

	/** Whether Backspace, with the focus on this, means Delete. */
	static boolean deletes(Component c) {
		Window w = c instanceof Window ? (Window) c : c == null ? null : SwingUtilities.getWindowAncestor(c);
		if (!(w instanceof BasicFrame) || c instanceof JTextComponent
				|| SwingUtilities.getAncestorOfClass(JComboBox.class, c) != null
				|| SwingUtilities.getAncestorOfClass(JSpinner.class, c) != null
				|| SwingUtilities.getAncestorOfClass(FlightConfigurablePanel.class, c) != null) {
			return false;
		}
		return !(c instanceof JTable) || SwingUtilities.getAncestorOfClass(SimulationPanel.class, c) != null;
	}
}
