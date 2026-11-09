package orcloud.web;

import java.awt.AWTEvent;
import java.awt.Component;
import java.awt.EventQueue;
import java.awt.Toolkit;
import java.awt.event.InputEvent;
import java.awt.event.MouseEvent;

/**
 * On a Mac, the Command key (⌘) adds to a selection, as in OpenRocket on a Mac: ⌘-click picks
 * several parts in the component tree (and several rows in OpenRocket's lists and tables) without
 * the ones in between, which Shift-click takes. Under CheerpJ, Java's shortcut key is Ctrl on every
 * computer, so Swing took ⌘-click as a plain click; and on a Mac, Ctrl-click is a right click.
 * Mouse events with ⌘ held now also count as Ctrl held. They keep ⌘, which OpenRocket itself looks
 * for in places (⌘-click in the rocket figure, ⌘-double-click to edit several parts at once).
 * The page tells Java it runs on a Mac (system property orcloud.mac).
 */
public final class CommandClick {
	private CommandClick() {
	}

	public static void install() {
		if (!Boolean.getBoolean("orcloud.mac")) {
			return;
		}
		Toolkit.getDefaultToolkit().getSystemEventQueue().push(new EventQueue() {
			@Override
			protected void dispatchEvent(AWTEvent e) {
				super.dispatchEvent(e.getClass() == MouseEvent.class ? withCtrl((MouseEvent) e) : e);
			}
		});
	}

	/** The event, with Ctrl held too if ⌘ is. */
	static MouseEvent withCtrl(MouseEvent e) {
		int mods = e.getModifiersEx();
		if ((mods & InputEvent.META_DOWN_MASK) == 0 || (mods & InputEvent.CTRL_DOWN_MASK) != 0
				|| !(e.getSource() instanceof Component)) {
			return e;
		}
		return new MouseEvent((Component) e.getSource(), e.getID(), e.getWhen(), mods | InputEvent.CTRL_DOWN_MASK,
				e.getX(), e.getY(), e.getXOnScreen(), e.getYOnScreen(), e.getClickCount(), e.isPopupTrigger(),
				e.getButton());
	}
}
