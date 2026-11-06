package orcloud.web;

import java.awt.AWTEvent;
import java.awt.Component;
import java.awt.Container;
import java.awt.Rectangle;
import java.awt.Toolkit;
import java.awt.Window;
import java.awt.event.WindowEvent;

import javax.swing.JFileChooser;

/**
 * Tells the page which windows are file dialogs. CheerpJ puts an "add files" button (uploading
 * from the user's computer into /files/uploads) on every window's title bar; the page shows it
 * only on file dialogs, the one place it is of use, for example to pick a decal image.
 */
public final class FileWindows {
	private FileWindows() {
	}

	/** The window with these bounds (in the CheerpJ display) is a file dialog. */
	private static native void jsFileWindow(int x, int y, int width, int height);

	public static void install() {
		Toolkit.getDefaultToolkit().addAWTEventListener(e -> {
			int id = e.getID();
			if ((id == WindowEvent.WINDOW_OPENED || id == WindowEvent.WINDOW_ACTIVATED) && e.getSource() instanceof Window
					&& hasFileChooser((Window) e.getSource())) {
				Rectangle b = ((Window) e.getSource()).getBounds();
				jsFileWindow(b.x, b.y, b.width, b.height);
			}
		}, AWTEvent.WINDOW_EVENT_MASK);
	}

	private static boolean hasFileChooser(Container c) {
		for (Component k : c.getComponents()) {
			if (k instanceof JFileChooser || (k instanceof Container && hasFileChooser((Container) k))) {
				return true;
			}
		}
		return false;
	}
}
