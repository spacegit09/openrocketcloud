package orcloud.web;

import java.awt.Color;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.Insets;
import java.awt.Point;

import javax.swing.JFrame;
import javax.swing.JMenu;
import javax.swing.JMenuBar;
import javax.swing.SwingUtilities;
import javax.swing.UIManager;
import javax.swing.border.Border;
import javax.swing.border.CompoundBorder;
import javax.swing.border.EmptyBorder;

/**
 * OpenRocket's menus in the page's header row (browser version). The page's header (back button,
 * design name, sharing) lies over the top of OpenRocket's window, and the menu bar, made as tall as
 * the header, shows its menus in the gap the page leaves after the design's name; the header takes
 * the menu bar's colours. The menus stay OpenRocket's own, with their shortcuts and submenus. Where
 * the header has no room for them, they are a row of their own under it, as before.
 *
 * The page places the menus with "x,height": the gap's left edge in the window and the header's
 * height; x is -1 for a row of their own under a header of that height.
 */
public final class MenuRow {
	/** In the header row, a menu's highlight is this much taller than its text row. */
	private static final int EXTRA_HEIGHT = 10;

	private static JMenuBar bar;
	private static Border border;
	private static String placed = "";

	private MenuRow() {
	}

	/** Tells the page how wide the menus are and the menu bar's colours (#rrggbb); returns where to place them. */
	private static native String jsMenus(int width, String background, String foreground, String line);

	/** Waits for the page's next placement. */
	private static native String jsNextPlace();

	/** The menus show at `placement` now. */
	private static native void jsPlaced(String placement);

	/** The menus are drawn: the header can show them. */
	private static native void jsShow();

	public static void install(JFrame frame) {
		bar = frame.getJMenuBar();
		if (bar == null) {
			return;
		}
		border = bar.getBorder();
		int width = 0;
		for (Component c : bar.getComponents()) {
			width += c.getPreferredSize().width;
		}
		JMenu first = bar.getMenuCount() > 0 ? bar.getMenu(0) : null;
		Color line = UIManager.getColor("MenuBar.borderColor");
		if (line == null) {
			line = UIManager.getColor("Separator.foreground");
		}
		place(jsMenus(width, hex(bar.getBackground(), Color.WHITE), hex(first != null ? first.getForeground() : null, Color.BLACK),
				hex(line, Color.LIGHT_GRAY)));
		Thread t = new Thread(() -> {
			while (true) {
				String p = jsNextPlace();
				if (p != null) {
					SwingUtilities.invokeLater(() -> place(p));
				}
			}
		}, "menu-row");
		t.setDaemon(true);
		t.start();
	}

	/**
	 * Lets the header show the menus, once they are drawn: on the UI thread, after the last
	 * placement's redraw.
	 */
	public static void show() {
		if (bar != null) {
			jsShow();
		}
	}

	/** Places the menus at `placement` now, if it is not null (on the UI thread). */
	public static void placeNow(String placement) {
		if (bar != null && placement != null) {
			place(placement);
		}
	}

	private static void place(String placement) {
		if (placement == null || placement.equals(placed)) {
			return;
		}
		int x, height;
		try {
			String[] s = placement.split(",");
			x = Integer.parseInt(s[0].trim());
			height = Integer.parseInt(s[1].trim());
		} catch (RuntimeException e) {
			return;
		}
		Point at = bar.isShowing() ? bar.getLocationOnScreen() : new Point();
		int row = Math.max(0, height - at.y); // the header's part over the menu bar
		bar.setPreferredSize(null);
		if (x < 0) {
			// A row of their own, under the header.
			Border under = new EmptyBorder(row, 0, 0, 0);
			bar.setBorder(border != null ? new CompoundBorder(under, border) : under);
		} else {
			int text = 0;
			for (Component c : bar.getComponents()) {
				text = Math.max(text, c.getPreferredSize().height);
			}
			Insets in = border != null ? border.getBorderInsets(bar) : new Insets(0, 0, 0, 0);
			int room = row - in.top - in.bottom;
			int menu = Math.min(room, text + EXTRA_HEIGHT);
			int top = Math.max(0, (room - menu) / 2);
			Border gap = new EmptyBorder(top, Math.max(0, x - at.x), Math.max(0, room - menu - top), 0);
			bar.setBorder(border != null ? new CompoundBorder(border, gap) : gap);
			bar.setPreferredSize(new Dimension(bar.getPreferredSize().width, row));
		}
		placed = placement;
		bar.revalidate();
		bar.repaint();
		jsPlaced(placement);
	}

	private static String hex(Color c, Color otherwise) {
		Color k = c != null ? c : otherwise;
		return String.format("#%02x%02x%02x", k.getRed(), k.getGreen(), k.getBlue());
	}
}
