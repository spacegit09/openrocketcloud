package orcloud.web;

import java.awt.Color;
import java.awt.Component;
import java.awt.Dimension;
import java.awt.event.HierarchyEvent;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Consumer;
import java.util.prefs.Preferences;

import javax.swing.JButton;
import javax.swing.JComboBox;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JSeparator;
import javax.swing.JSpinner;
import javax.swing.JTable;
import javax.swing.SpinnerNumberModel;
import javax.swing.Timer;
import javax.swing.table.AbstractTableModel;
import javax.swing.table.DefaultTableCellRenderer;

import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.rocketcomponent.ComponentChangeListener;
import info.openrocket.core.rocketcomponent.FinSet;
import info.openrocket.core.rocketcomponent.TrapezoidFinSet;
import info.openrocket.core.simulation.FlightData;
import info.openrocket.core.simulation.FlightDataBranch;
import info.openrocket.core.simulation.FlightDataType;
import info.openrocket.core.unit.Unit;
import info.openrocket.core.unit.UnitGroup;
import info.openrocket.core.util.Invalidatable;
import info.openrocket.swing.gui.util.GUIUtil;
import net.miginfocom.swing.MigLayout;
import orcloud.fins.FinFlutter;

/**
 * The "Flutter" tab of a fin set's Edit dialog (browser version; added by our copy of
 * RocketComponentConfig): the fins' flutter speed ({@link FinFlutter}), from their shape, thickness
 * and material, and how close each of the design's simulations comes to it, along the whole flight
 * in that simulation's own air.
 *
 * OpenRocket's materials have no stiffness, so the tab starts from a typical shear modulus for the
 * fin material, which can be changed; a value entered is kept in this browser for the fin set (as
 * the export dialog keeps fin cross sections).
 */
public final class FlutterTab {
	public static final String TITLE = "Flutter";
	public static final String TIP = "The fins' flutter speed, and how close your simulations come to it";

	private static final Preferences PREFS = Preferences.userRoot().node("orcloud-web").node("flutter");
	private static final String UNIT = "unit";
	/** Shear modulus units: name, Pa. */
	private static final String[] UNITS = { "GPa", "MPa", "ksi", "psi" };
	private static final double[] PASCALS = { 1e9, 1e6, 6894757.29, 6894.75729 };
	/** Below this margin (flutter speed over airspeed), the fins come close to fluttering. */
	static final double LOW = 1.25;

	private FlutterTab() {
	}

	/** The tab's content; `register` takes what must be released when the dialog closes. */
	public static JPanel panel(OpenRocketDocument doc, FinSet fins, Consumer<Invalidatable> register) {
		Panel p = new Panel(doc, fins);
		register.accept(p::close);
		return p;
	}

	/** The shear modulus (Pa) the fin set is checked with: entered for it, or its material's typical one (NaN if none). */
	static double shearModulus(FinSet fins) {
		double entered = PREFS.getDouble(String.valueOf(fins.getID()), Double.NaN);
		return entered > 0 ? entered : FinFlutter.typicalShearModulus(fins.getMaterial().getName());
	}

	/** The fin set as FinFlutter sees it: one fin's root chord, span, area, thickness and centre of area. */
	static FinFlutter flutter(FinSet fins) {
		info.openrocket.core.util.Coordinate[] outline = fins.getFinPoints();
		double[] x = new double[outline.length], y = new double[outline.length];
		for (int i = 0; i < outline.length; i++) {
			x[i] = outline[i].x;
			y[i] = outline[i].y;
		}
		return new FinFlutter(fins.getLength(), fins.getSpan(), fins.getPlanformArea(), fins.getThickness(), FinFlutter.centroid(x, y));
	}

	/** One row of the simulations table. */
	private static final class Row {
		final String name;
		String fastest = "", flutter = "", margin = "", where = "";
		int level; // 0 fine, 1 low margin, 2 flutter, -1 nothing to judge
		double factor = Double.NaN;

		Row(String name) {
			this.name = name;
		}
	}

	private static final class Panel extends JPanel {
		private final OpenRocketDocument doc;
		private final FinSet fins;
		private final JLabel material = new JLabel();
		private final SpinnerNumberModel modulus = new SpinnerNumberModel(1.0, 0.0, 1e7, 0.1);
		private final JComboBox<String> unit = new JComboBox<>(UNITS);
		private final JButton typical = new JButton("Use the material's typical value");
		private final JLabel source = new JLabel();
		private final JLabel shape = new JLabel();
		private final JLabel seaLevel = new JLabel();
		private final JLabel summary = new JLabel();
		private final List<Row> rows = new ArrayList<>();
		private final AbstractTableModel table = new AbstractTableModel() {
			private final String[] columns = { "Simulation", "Fastest", "Flutter speed there", "Margin", "Where" };

			@Override
			public int getRowCount() {
				return rows.size();
			}

			@Override
			public int getColumnCount() {
				return columns.length;
			}

			@Override
			public String getColumnName(int c) {
				return columns[c];
			}

			@Override
			public Object getValueAt(int r, int c) {
				Row row = rows.get(r);
				switch (c) {
				case 0: return row.name;
				case 1: return row.fastest;
				case 2: return row.flutter;
				case 3: return row.margin;
				default: return row.where;
				}
			}
		};
		// Edits elsewhere in the dialog only mark the tab out of date: it is worked out when it shows.
		private final ComponentChangeListener changed = e -> {
			if (isShowing()) {
				refresh(true);
			} else {
				seen = "";
			}
		};
		private final Timer poll = new Timer(1500, e -> refresh(false));
		private String seen = "";
		private boolean filling;

		Panel(OpenRocketDocument doc, FinSet fins) {
			super(new MigLayout("fill, gap rel unrel", "[][grow]", "[][][][][]para[][grow 100][]"));
			this.doc = doc;
			this.fins = fins;

			add(new JLabel("Fin material:"));
			add(material, "wrap");

			add(new JLabel("Shear modulus:"));
			JSpinner spinner = new JSpinner(modulus);
			spinner.setEditor(new JSpinner.NumberEditor(spinner, "0.###"));
			spinner.setToolTipText("The fin material's stiffness in shear (twisting). Wood depends on the grain, 3D prints on the printing.");
			JPanel stiffness = new JPanel(new MigLayout("insets 0, hidemode 3"));
			stiffness.add(spinner, "w 80lp");
			stiffness.add(unit);
			stiffness.add(source, "gapleft para");
			stiffness.add(typical, "gapleft para");
			source.setForeground(Color.GRAY);
			add(stiffness, "wrap");

			add(new JLabel("Fin:"));
			add(shape, "wrap");

			add(new JLabel("Flutter speed:"));
			add(seaLevel, "wrap");

			add(new JSeparator(), "span, growx, wrap");

			add(summary, "span, wrap");
			JTable t = new JTable(table);
			t.setFillsViewportHeight(true);
			t.setRowSelectionAllowed(false);
			t.getColumnModel().getColumn(0).setPreferredWidth(160);
			t.getColumnModel().getColumn(3).setCellRenderer(new DefaultTableCellRenderer() {
				@Override
				public Component getTableCellRendererComponent(JTable table, Object value, boolean selected, boolean focus, int r, int c) {
					Component cell = super.getTableCellRendererComponent(table, value, selected, focus, r, c);
					int level = rows.get(r).level;
					cell.setForeground(level == 2 ? GUIUtil.getUITheme().getErrorColor()
							: level == 1 ? GUIUtil.getUITheme().getWarningColor() : table.getForeground());
					return cell;
				}
			});
			JScrollPane scroll = new JScrollPane(t);
			scroll.setPreferredSize(new Dimension(520, 96));
			add(scroll, "span, grow, wrap");

			// A set width, so the wrapped text is measured at it.
			JLabel note = new JLabel("<html><body style='width: 470px'>Martin's flutter boundary (NACA TN 4197) as Bennett"
					+ " corrected it for rockets (Apogee's Peak of Flight 615), with ε from the fin's sweep (at least Martin's 0.25),"
					+ " in each simulation's own air. Margin is the flutter speed over the airspeed at the closest point of the"
					+ " flight. It is a rough guide: keep at least " + Math.round((LOW - 1) * 100) + "% margin. It leaves out fin"
					+ " tabs, fillets and how the fins are mounted, which stiffen them; materials vary. Other outlines count as the"
					+ " trapezoid of the same root chord, span and area.</body></html>");
			note.setFont(note.getFont().deriveFont(note.getFont().getSize2D() - 1f));
			note.setForeground(Color.GRAY);
			add(note, "span");

			String chosen = PREFS.get(UNIT, null);
			String length = UnitGroup.UNITS_LENGTH.getDefaultUnit().getUnit();
			unit.setSelectedItem(chosen != null ? chosen : length.equals("in") || length.equals("ft") ? "ksi" : "GPa");
			unit.addActionListener(e -> {
				PREFS.put(UNIT, (String) unit.getSelectedItem());
				refresh(true);
			});
			modulus.addChangeListener(e -> {
				if (!filling) {
					double pa = modulus.getNumber().doubleValue() * pascals();
					if (pa > 0) {
						PREFS.putDouble(String.valueOf(fins.getID()), pa);
						refresh(true);
					}
				}
			});
			typical.addActionListener(e -> {
				PREFS.remove(String.valueOf(fins.getID()));
				refresh(true);
			});
			fins.addComponentChangeListener(changed);
			// The simulations are looked at again while the tab shows (one may have been run meanwhile).
			addHierarchyListener(e -> {
				if ((e.getChangeFlags() & HierarchyEvent.SHOWING_CHANGED) != 0) {
					if (isShowing()) {
						refresh(false);
						poll.start();
					} else {
						poll.stop();
					}
				}
			});
			refresh(true); // the first time (to learn the tab's size), also before it shows
		}

		void close() {
			poll.stop();
			fins.removeComponentChangeListener(changed);
		}

		private double pascals() {
			return PASCALS[Math.max(0, unit.getSelectedIndex())];
		}

		/** Updates the tab; unless `always`, only when the fins, their stiffness or a simulation changed. */
		private void refresh(boolean always) {
			double g = shearModulus(fins);
			StringBuilder key = new StringBuilder().append(fins.getRocket().getModID()).append(' ').append(g).append(' ').append(unit.getSelectedIndex());
			for (Simulation sim : doc.getSimulations()) {
				key.append(' ').append(System.identityHashCode(sim)).append(':').append(System.identityHashCode(sim.getSimulatedData()))
						.append(':').append(sim.getStatus());
			}
			if (!always && (key.toString().equals(seen) || !isShowing())) {
				return;
			}
			seen = key.toString();

			material.setText(fins.getMaterial().getName());
			boolean entered = PREFS.getDouble(String.valueOf(fins.getID()), Double.NaN) > 0;
			boolean known = FinFlutter.typicalShearModulus(fins.getMaterial().getName()) > 0;
			typical.setVisible(entered && known);
			source.setText(entered ? "entered" : known ? "typical for this material" : "");
			filling = true;
			modulus.setValue(g > 0 ? round(g / pascals()) : 0.0);
			filling = false;

			FinFlutter fin = flutter(fins);
			rows.clear();
			if (!fin.valid()) {
				shape.setText("needs a thickness, span and root chord");
				seaLevel.setText("");
				summary.setText("");
				table.fireTableDataChanged();
				return;
			}
			shape.setText(String.format(Locale.ROOT, "aspect ratio %.2f, taper ratio %.2f, %.1f %% as thick as the root chord, ε %.2f%s",
					fin.aspectRatio, fin.taper, fin.thicknessRatio * 100, fin.epsilon,
					fins instanceof TrapezoidFinSet ? "" : " (its trapezoid)"));
			if (!(g > 0)) {
				seaLevel.setText("enter the material's shear modulus");
				summary.setText("");
				table.fireTableDataChanged();
				return;
			}
			double vf = fin.speedAtSeaLevel(g);
			seaLevel.setText(speed(vf) + String.format(Locale.ROOT, " (Mach %.2f) at sea level", vf / FinFlutter.SEA_LEVEL_SOUND));

			Row worst = null;
			for (Simulation sim : doc.getSimulations()) {
				Row row = check(sim, fin, g);
				rows.add(row);
				if (row.level >= 0 && (worst == null || row.factor < worst.factor)) {
					worst = row;
				}
			}
			if (rows.isEmpty()) {
				summary.setText("No simulations yet: run one (Flight simulations) to check the fins against its speed.");
			} else if (worst == null) {
				summary.setText("Run your simulations to check the fins against their speed.");
			} else {
				summary.setText(worst.level == 2 ? "Faster than the flutter speed in " + worst.name + "."
						: worst.level == 1 ? "Within " + Math.round((LOW - 1) * 100) + "% of the flutter speed in " + worst.name + "."
						: "Every simulation stays well below the flutter speed.");
				summary.setForeground(worst.level == 2 ? GUIUtil.getUITheme().getErrorColor()
						: worst.level == 1 ? GUIUtil.getUITheme().getWarningColor() : UIManagerText.color());
			}
			table.fireTableDataChanged();
		}

		/** One simulation, along its flight (the branch of the fins' stage), in its own air. */
		private Row check(Simulation sim, FinFlutter fin, double g) {
			boolean current = Simulation.isStatusUpToDate(sim.getStatus());
			Row row = new Row(sim.getName() + (current ? "" : " (outdated)"));
			row.level = -1;
			FlightData data = sim.getSimulatedData();
			if (data == null || data.getBranchCount() == 0) {
				row.fastest = "not run yet";
				return row;
			}
			FlightDataBranch branch = data.getBranch(0);
			String stage = fins.getStage().getName();
			for (int b = 0; b < data.getBranchCount(); b++) {
				if (stage.equals(data.getBranch(b).getName())) {
					branch = data.getBranch(b);
				}
			}
			List<Double> time = branch.get(FlightDataType.TYPE_TIME), alt = branch.get(FlightDataType.TYPE_ALTITUDE);
			List<Double> mach = branch.get(FlightDataType.TYPE_MACH_NUMBER), total = branch.get(FlightDataType.TYPE_VELOCITY_TOTAL);
			List<Double> pressure = branch.get(FlightDataType.TYPE_AIR_PRESSURE), sound = branch.get(FlightDataType.TYPE_SPEED_OF_SOUND);
			if (time == null || (mach == null && total == null)) {
				row.fastest = "no flight data";
				return row;
			}
			int n = time.size();
			double launch = sim.getOptions().getLaunchAltitude();
			double[] v = new double[n], p = new double[n], a = new double[n];
			double fastest = 0;
			for (int i = 0; i < n; i++) {
				double h = at(alt, i);
				double[] standard = FinFlutter.standardAir(launch + (Double.isNaN(h) ? 0 : h));
				p[i] = at(pressure, i) > 0 ? at(pressure, i) : standard[0];
				a[i] = at(sound, i) > 0 ? at(sound, i) : standard[1];
				// Airspeed (Mach times the speed of sound); the speed over the ground where it is missing.
				double m = at(mach, i);
				v[i] = m >= 0 ? m * a[i] : at(total, i);
				if (v[i] > fastest) {
					fastest = v[i];
				}
			}
			row.fastest = speed(fastest);
			FinFlutter.Margin m = fin.lowest(g, v, p, a);
			if (m == null) {
				row.margin = "-";
				return row;
			}
			row.flutter = speed(m.flutterSpeed);
			row.margin = String.format(Locale.ROOT, "%.2f×", m.factor) + (m.factor < 1 ? "  flutter likely" : m.factor < LOW ? "  low" : "");
			row.level = m.factor < 1 ? 2 : m.factor < LOW ? 1 : 0;
			row.factor = m.factor;
			double h = at(alt, m.index);
			row.where = String.format(Locale.ROOT, "%.1f s", time.get(m.index))
					+ (Double.isNaN(h) ? "" : ", " + UnitGroup.UNITS_DISTANCE.getDefaultUnit().toStringUnit(h));
			return row;
		}
	}

	private static double at(List<Double> values, int i) {
		if (values == null || i >= values.size()) {
			return Double.NaN;
		}
		Double d = values.get(i);
		return d == null ? Double.NaN : d;
	}

	private static String speed(double v) {
		Unit u = UnitGroup.UNITS_VELOCITY.getDefaultUnit();
		return u.toStringUnit(v);
	}

	/** Three significant digits. */
	private static double round(double x) {
		if (!(x > 0)) {
			return 0;
		}
		double scale = Math.pow(10, 2 - Math.floor(Math.log10(x)));
		return Math.round(x * scale) / scale;
	}

	/** The look and feel's usual label colour. */
	private static final class UIManagerText {
		static Color color() {
			Color c = javax.swing.UIManager.getColor("Label.foreground");
			return c != null ? c : Color.BLACK;
		}
	}
}
