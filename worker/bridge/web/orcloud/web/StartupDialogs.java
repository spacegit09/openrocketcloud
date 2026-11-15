package orcloud.web;

import java.awt.AWTEvent;
import java.awt.Component;
import java.awt.Container;
import java.awt.Dialog;
import java.awt.Toolkit;
import java.awt.Window;
import java.awt.event.AWTEventListener;
import java.awt.event.ComponentEvent;
import java.awt.event.WindowEvent;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;

import javax.swing.JProgressBar;

/**
 * Windows OpenRocket opens and waits on while it starts, such as "Warnings while opening file" when
 * a design's motor cannot be found. OpenRocket goes no further until one is answered, but the page
 * covers OpenRocket with its loading screen until OpenRocket is ready, so the window was never seen
 * and the design never opened. The page now shows OpenRocket while one is open
 * (src/java.js, jsDialogs), and covers it again when it closes, until OpenRocket is ready.
 * Progress windows ("Opening file", with a progress bar and Cancel), which OpenRocket shows while
 * a larger design opens and closes by itself, are part of the loading and stay covered.
 */
public final class StartupDialogs {
	private StartupDialogs() {
	}

	private static native void jsDialogs(int open);

	private static final Set<Window> OPEN = Collections.newSetFromMap(new IdentityHashMap<>());
	private static AWTEventListener listener;

	/** From the start: before OpenRocket can open anything. */
	public static synchronized void install() {
		if (listener != null) {
			return;
		}
		listener = e -> {
			if (!(e.getSource() instanceof Dialog)) {
				return;
			}
			Dialog d = (Dialog) e.getSource();
			if (!d.isModal()) {
				return; // OpenRocket does not wait on these
			}
			int id = e.getID();
			boolean changed;
			synchronized (OPEN) {
				if (id == WindowEvent.WINDOW_OPENED || id == ComponentEvent.COMPONENT_SHOWN) {
					changed = d.isShowing() && !hasProgressBar(d) && OPEN.add(d);
				} else if (id == WindowEvent.WINDOW_CLOSED || id == ComponentEvent.COMPONENT_HIDDEN) {
					changed = OPEN.remove(d);
				} else {
					return;
				}
			}
			if (changed) {
				report();
			}
		};
		Toolkit.getDefaultToolkit().addAWTEventListener(listener, AWTEvent.WINDOW_EVENT_MASK | AWTEvent.COMPONENT_EVENT_MASK);
	}

	/** OpenRocket is ready and the page shows it anyway: no need to watch any more. */
	public static synchronized void done() {
		if (listener != null) {
			Toolkit.getDefaultToolkit().removeAWTEventListener(listener);
			listener = null;
		}
		synchronized (OPEN) {
			OPEN.clear();
		}
	}

	private static boolean hasProgressBar(Container c) {
		for (Component child : c.getComponents()) {
			if (child instanceof JProgressBar || (child instanceof Container && hasProgressBar((Container) child))) {
				return true;
			}
		}
		return false;
	}

	private static void report() {
		int n;
		synchronized (OPEN) {
			n = OPEN.size();
		}
		try {
			jsDialogs(n);
		} catch (Throwable t) {
			// not in a browser (tests): nothing to tell
		}
	}
}
