package orcloud.web;

import java.awt.AWTEvent;
import java.awt.BasicStroke;
import java.awt.Color;
import java.awt.Dimension;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.Toolkit;
import java.awt.event.ContainerEvent;
import java.awt.geom.Path2D;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.prefs.Preferences;

import javax.swing.JCheckBox;
import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JSeparator;
import javax.swing.JSpinner;
import javax.swing.SpinnerNumberModel;
import javax.swing.SwingUtilities;
import javax.swing.UIManager;

import info.openrocket.core.rocketcomponent.FinSet;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.swing.gui.choosers.OBJOptionChooser;
import net.miginfocom.swing.MigLayout;
import orcloud.fins.FinProfile;

/**
 * Fin cross sections in 3D export (browser version). OpenRocket exports every fin as a flat plate;
 * our FinSetExporter builds it with its cross section (orcloud.fins.AirfoilFin): square fins stay
 * flat, rounded fins get rounded edges, and airfoil fins the profile chosen for them here, in a
 * "Fin cross sections" part added to OpenRocket's OBJ export options. The choices, and whether the
 * thickness shrinks toward the tip, are kept in this browser (with OpenRocket's preferences).
 */
public final class FinProfiles {
	private static final Preferences PREFS = Preferences.userRoot().node("orcloud-web").node("fin-profiles");
	private static final String DEFAULT = "default";
	private static final String SCALED = "scaled";
	private static final FinProfile.Type[] AIRFOILS = { FinProfile.Type.NACA, FinProfile.Type.BICONVEX, FinProfile.Type.DOUBLE_WEDGE,
			FinProfile.Type.HEXAGONAL, FinProfile.Type.ROUNDED_TAPERED, FinProfile.Type.ROUNDED };
	private static boolean installed;

	private FinProfiles() {
	}

	/** How the fin is exported: null for flat (square), else its profile. */
	public static FinProfile forFin(FinSet fin) {
		switch (fin.getCrossSection()) {
		case ROUNDED:
			return new FinProfile(FinProfile.Type.ROUNDED, FinProfile.DEFAULT_EDGE, scaled());
		case AIRFOIL: {
			FinProfile p = chosen(fin);
			return new FinProfile(p.type, p.edge, scaled());
		}
		default:
			return null;
		}
	}

	/** The profile chosen for an airfoil fin (the last one chosen for any, at first). */
	public static FinProfile chosen(FinSet fin) {
		FinProfile fallback = FinProfile.parse(PREFS.get(DEFAULT, null), new FinProfile(FinProfile.Type.NACA));
		return FinProfile.parse(PREFS.get(String.valueOf(fin.getID()), null), fallback);
	}

	public static void choose(FinSet fin, FinProfile profile) {
		String text = new FinProfile(profile.type, profile.edge, false).toString();
		PREFS.put(String.valueOf(fin.getID()), text);
		PREFS.put(DEFAULT, text);
	}

	public static boolean scaled() {
		return PREFS.getBoolean(SCALED, false);
	}

	/** Adds the fin part to OpenRocket's OBJ export options whenever they open. */
	public static void install() {
		if (installed) {
			return;
		}
		installed = true;
		Toolkit.getDefaultToolkit().addAWTEventListener(e -> {
			if (e.getID() == ContainerEvent.COMPONENT_ADDED && ((ContainerEvent) e).getChild() instanceof OBJOptionChooser) {
				OBJOptionChooser options = (OBJOptionChooser) ((ContainerEvent) e).getChild();
				SwingUtilities.invokeLater(() -> addTo(options));
			}
		}, AWTEvent.CONTAINER_EVENT_MASK);
	}

	private static void addTo(OBJOptionChooser options) {
		if (options.getClientProperty(FinProfiles.class) != null) {
			return;
		}
		options.putClientProperty(FinProfiles.class, true);
		Rocket rocket;
		try {
			Field f = OBJOptionChooser.class.getDeclaredField("rocket");
			f.setAccessible(true);
			rocket = (Rocket) f.get(options);
		} catch (ReflectiveOperationException | RuntimeException e) {
			System.err.println("Fin cross sections unavailable: " + e);
			return;
		}
		List<FinSet> fins = new ArrayList<>();
		for (RocketComponent c : rocket) {
			if (c instanceof FinSet) {
				fins.add((FinSet) c);
			}
		}
		if (fins.isEmpty()) {
			return;
		}
		JPanel panel = new JPanel(new MigLayout("ins 0, fillx", "[]rel[grow]"));
		JLabel title = new JLabel("Fin cross sections");
		title.setFont(title.getFont().deriveFont(java.awt.Font.BOLD));
		panel.add(title, "spanx, wrap");
		for (FinSet fin : fins) {
			panel.add(new JLabel(fin.getName()), "gapleft 10lp, top, gaptop 3lp");
			panel.add(row(fin), "growx, wrap");
		}
		JCheckBox scaled = new JCheckBox("Thinner toward the tip (the root's thickness-to-chord ratio)");
		scaled.setSelected(scaled());
		scaled.setToolTipText("Off: the fin's thickness all the way to the tip, as fins cut from sheet. On: the thickness shrinks with the chord.");
		scaled.addActionListener(e -> PREFS.putBoolean(SCALED, scaled.isSelected()));
		panel.add(scaled, "spanx, gapleft 10lp, wrap");
		JLabel note = new JLabel("Square, rounded or airfoil: each fin's Cross section, in its Edit dialog.");
		note.setFont(note.getFont().deriveFont(note.getFont().getSize2D() - 1f));
		note.setForeground(UIManager.getColor("Label.disabledForeground"));
		panel.add(note, "spanx, gapleft 10lp");
		options.add(new JSeparator(JSeparator.HORIZONTAL), "spanx, growx, wrap para");
		options.add(panel, "spanx, growx, wrap");
		options.revalidate();
		options.repaint();
		SwingUtilities.invokeLater(() -> {
			java.awt.Window w = SwingUtilities.getWindowAncestor(options);
			if (w != null) {
				w.pack();
			}
		});
	}

	/** One fin set's line: its cross section, and for an airfoil its profile and a drawing of it. */
	private static JComponent row(FinSet fin) {
		JPanel row = new JPanel(new MigLayout("ins 0", "[][][]"));
		switch (fin.getCrossSection()) {
		case ROUNDED:
			row.add(new JLabel("Rounded edges"));
			row.add(new Section(fin, () -> new FinProfile(FinProfile.Type.ROUNDED)), "gapleft para");
			return row;
		case AIRFOIL:
			break;
		default:
			row.add(new JLabel("Flat (square)"));
			return row;
		}
		FinProfile current = chosen(fin);
		JComboBox<FinProfile.Type> type = new JComboBox<>(AIRFOILS);
		type.setSelectedItem(current.type);
		JSpinner edge = new JSpinner(new SpinnerNumberModel((int) Math.round(current.edge * 100), 2, 48, 1));
		JLabel edgeLabel = new JLabel("% of chord");
		Section section = new Section(fin, () -> new FinProfile((FinProfile.Type) type.getSelectedItem(), ((Number) edge.getValue()).intValue() / 100.0, false));
		Runnable changed = () -> {
			FinProfile p = new FinProfile((FinProfile.Type) type.getSelectedItem(), ((Number) edge.getValue()).intValue() / 100.0, false);
			choose(fin, p);
			boolean hasEdge = p.type.hasEdge;
			edge.setVisible(hasEdge);
			edgeLabel.setVisible(hasEdge);
			edge.setToolTipText(p.type == FinProfile.Type.HEXAGONAL ? "Length of each bevel" : "Length of the trailing-edge taper");
			section.repaint();
			row.revalidate();
		};
		type.addActionListener(e -> changed.run());
		edge.addChangeListener(e -> changed.run());
		row.add(type, "split 3");
		row.add(edge, "w 50lp!, hidemode 3");
		row.add(edgeLabel, "hidemode 3");
		row.add(section, "gapleft para");
		edge.setVisible(current.type.hasEdge);
		edgeLabel.setVisible(current.type.hasEdge);
		return row;
	}

	/** A drawing of the root's cross section with the profile (thickness drawn larger, to be seen). */
	private static final class Section extends JComponent {
		private final FinSet fin;
		private final java.util.function.Supplier<FinProfile> profile;

		Section(FinSet fin, java.util.function.Supplier<FinProfile> profile) {
			this.fin = fin;
			this.profile = profile;
			setPreferredSize(new Dimension(120, 26));
			setToolTipText("The fin's cross section at the root (thickness exaggerated)");
		}

		@Override
		protected void paintComponent(Graphics g0) {
			Graphics2D g = (Graphics2D) g0.create();
			g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
			double chord = Math.max(1e-6, fin.getLength());
			// As drawn: at least a sixth of the chord thick, so the shape shows.
			double ratio = Math.max(fin.getThickness() / chord, 1.0 / 6);
			double w = getWidth() - 4, h = Math.min(getHeight() - 4, w * ratio);
			double t = chord * ratio;
			FinProfile p = profile.get();
			FinProfile.Stations st = p.stations(48, chord, t);
			Path2D.Double path = new Path2D.Double();
			double mid = getHeight() / 2.0;
			for (int i = 0; i < st.s.length; i++) {
				double x = 2 + st.s[i] * w, y = mid - p.half(st.s[i], chord, t) / t * h;
				if (i == 0) {
					path.moveTo(x, y);
				} else {
					path.lineTo(x, y);
				}
			}
			for (int i = st.s.length - 1; i >= 0; i--) {
				path.lineTo(2 + st.s[i] * w, mid + p.half(st.s[i], chord, t) / t * h);
			}
			path.closePath();
			Color fg = UIManager.getColor("Label.foreground");
			g.setColor(new Color(fg.getRed(), fg.getGreen(), fg.getBlue(), 40));
			g.fill(path);
			g.setColor(fg);
			g.setStroke(new BasicStroke(1.2f));
			g.draw(path);
			g.dispose();
		}
	}
}
