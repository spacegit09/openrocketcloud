package orcloud.web;

import java.awt.Color;
import java.awt.Component;
import java.awt.Font;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import javax.swing.DefaultListCellRenderer;
import javax.swing.JButton;
import javax.swing.JCheckBox;
import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JDialog;
import javax.swing.JLabel;
import javax.swing.JList;
import javax.swing.JMenu;
import javax.swing.JMenuBar;
import javax.swing.JMenuItem;
import javax.swing.JPanel;
import javax.swing.JScrollPane;
import javax.swing.JSeparator;
import javax.swing.JSpinner;
import javax.swing.JTabbedPane;
import javax.swing.JTable;
import javax.swing.SpinnerNumberModel;
import javax.swing.SwingUtilities;
import javax.swing.table.AbstractTableModel;

import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.rocketcomponent.BodyTube;
import info.openrocket.core.rocketcomponent.ComponentChangeListener;
import info.openrocket.core.rocketcomponent.MassComponent;
import info.openrocket.core.rocketcomponent.Parachute;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.startup.Application;
import info.openrocket.core.unit.Unit;
import info.openrocket.core.unit.UnitGroup;
import info.openrocket.core.util.StateChangeListener;
import info.openrocket.swing.gui.SpinnerEditor;
import info.openrocket.swing.gui.adaptors.DoubleModel;
import info.openrocket.swing.gui.components.UnitSelector;
import info.openrocket.swing.gui.main.BasicFrame;
import info.openrocket.swing.gui.util.GUIUtil;
import net.miginfocom.swing.MigLayout;
import orcloud.recovery.Recovery;

/**
 * Two windows of helpers working from the design (browser version), each with its own item in the
 * Tools menu:
 * <ul>
 * <li>Recovery, in two tabs. Parachute: the size of a parachute for a descent rate, from what it
 * brings down (its stage after burnout, the parachute at that size) and the other recovery devices
 * open with it. Ejection charge: the black powder for a bay (found in the design around its
 * recovery device) at a pressure, allowing for how full the parachute packs it, its push on the
 * bulkhead, and the shear pins it breaks.</li>
 * <li>Ballast: the weight in the nose for a stability margin, for every motor configuration, as
 * the design view measures stability.</li>
 * </ul>
 * See orcloud.recovery.Recovery for the sums.
 */
public final class RecoveryHelpers {
	/** The windows, by their titles (and their menu items'). */
	public static final String RECOVERY = "Recovery", BALLAST = "Ballast";

	private RecoveryHelpers() {
	}

	/** Adds the menu items to OpenRocket's Tools menu. */
	public static void install(BasicFrame frame, OpenRocketDocument doc) {
		JMenuItem recovery = new JMenuItem(RECOVERY + "...");
		recovery.addActionListener(e -> new HelperDialog(frame, doc, false).setVisible(true));
		JMenuItem ballast = new JMenuItem(BALLAST + "...");
		ballast.addActionListener(e -> new HelperDialog(frame, doc, true).setVisible(true));
		JMenuBar bar = frame.getJMenuBar();
		String tools = Application.getTranslator().get("main.menu.tools");
		JMenu menu = null;
		for (int i = 0; i < bar.getMenuCount() && menu == null; i++) {
			JMenu m = bar.getMenu(i);
			if (m != null && tools.equals(m.getText())) {
				menu = m;
			}
		}
		if (menu == null) {
			menu = new JMenu("Tools");
			bar.add(menu);
		}
		menu.add(recovery);
		menu.add(ballast);
	}

	private static String length(double m) {
		return UnitGroup.UNITS_LENGTH.getDefaultUnit().toStringUnit(m);
	}

	private static String mass(double kg) {
		return UnitGroup.UNITS_MASS.getDefaultUnit().toStringUnit(kg);
	}

	private static boolean imperial() {
		String u = UnitGroup.UNITS_LENGTH.getDefaultUnit().getUnit();
		return u.equals("in") || u.equals("ft");
	}

	private static JSpinner spinner(DoubleModel model) {
		JSpinner s = new JSpinner(model.getSpinnerModel());
		s.setEditor(new SpinnerEditor(s));
		return s;
	}

	private static JLabel note(String html) {
		JLabel l = new JLabel("<html><body style='width: 430px'>" + html + "</body></html>");
		l.setFont(l.getFont().deriveFont(l.getFont().getSize2D() - 1f));
		l.setForeground(Color.GRAY);
		return l;
	}

	private static JLabel result() {
		JLabel l = new JLabel(" ");
		l.setFont(l.getFont().deriveFont(Font.BOLD, l.getFont().getSize2D() + 1f));
		return l;
	}

	/** HTML text that wraps at the width of the notes. */
	private static String wrapped(String html) {
		return "<html><body style='width: 430px'>" + html + "</body></html>";
	}

	private static String esc(String s) {
		return s.replace("&", "&amp;").replace("<", "&lt;");
	}

	private static final class HelperDialog extends JDialog {
		private final OpenRocketDocument doc;
		private final Rocket rocket;
		/** What redraws each tab (or the one panel); only the one showing is worked out. */
		private final List<Runnable> refreshers = new ArrayList<>();
		/** The Recovery window's tabs; the Ballast window has one panel and none. */
		private final JTabbedPane tabs = new JTabbedPane();
		private boolean refreshing, pending;
		/** Changes to the design come in bursts (a part's dialog, an undo): one redraw for each burst. */
		private final ComponentChangeListener changed = e -> {
			if (!pending) {
				pending = true;
				SwingUtilities.invokeLater(() -> {
					pending = false;
					refresh();
				});
			}
		};

		HelperDialog(BasicFrame frame, OpenRocketDocument doc, boolean ballast) {
			super(frame, ballast ? BALLAST : RECOVERY, false);
			this.doc = doc;
			this.rocket = doc.getRocket();
			JComponent body;
			if (ballast) {
				body = ballastPanel();
			} else {
				tabs.addTab("Parachute", parachuteTab());
				tabs.addTab("Ejection charge", ejectionTab());
				body = tabs;
			}
			JPanel pane = new JPanel(new MigLayout("fill, insets dialog", "[grow]", "[grow][]"));
			pane.add(body, "grow, wrap");
			JButton close = new JButton("Close");
			close.addActionListener(e -> dispose());
			pane.add(close, "right");
			setContentPane(pane);
			rocket.addComponentChangeListener(changed);
			addWindowListener(new WindowAdapter() {
				@Override
				public void windowClosed(WindowEvent e) {
					rocket.removeComponentChangeListener(changed);
				}
			});
			// Every tab filled in before sizing the window to them; then only the one showing.
			for (int i = 0; i < tabs.getTabCount(); i++) {
				tabs.setSelectedIndex(i);
				refresh();
			}
			if (tabs.getTabCount() > 0) {
				tabs.setSelectedIndex(0);
				tabs.addChangeListener(e -> refresh());
			} else {
				refresh();
			}
			// Enter takes a value typed in (no default button to close the window); Escape closes it.
			GUIUtil.installEscapeCloseOperation(this);
			setDefaultCloseOperation(DISPOSE_ON_CLOSE);
			pack();
			setLocationRelativeTo(frame);
		}

		private void refresh() {
			if (refreshing) {
				return;
			}
			int tab = tabs.getTabCount() > 0 ? tabs.getSelectedIndex() : 0;
			if (tab < 0 || tab >= refreshers.size()) {
				return;
			}
			refreshing = true;
			try {
				refreshers.get(tab).run();
			} catch (RuntimeException e) {
				// The design changed under the helper (a part deleted, say): the next change redraws it.
			} finally {
				refreshing = false;
			}
			if (isShowing()) {
				// Labels and buttons whose text changed are laid out again now; in the browser the
				// window otherwise kept their old sizes and cut the longer text off ("Add i...").
				validate();
				repaint();
				java.awt.Dimension want = getPreferredSize(), have = getSize();
				if (want.width > have.width || want.height > have.height) {
					setSize(Math.max(want.width, have.width), Math.max(want.height, have.height));
				}
			}
		}

		/**
		 * Puts the design's parts of a kind in a list, if they changed since: the one chosen stays,
		 * if it is still there. True if the one chosen changed.
		 */
		private static <T extends RocketComponent> boolean keepCurrent(JComboBox<T> box, List<T> now) {
			boolean same = box.getItemCount() == now.size();
			for (int i = 0; same && i < now.size(); i++) {
				same = box.getItemAt(i) == now.get(i);
			}
			if (same) {
				return false;
			}
			// Undo and redo put new copies of the parts in the design: the same part has the same ID.
			RocketComponent chosen = (RocketComponent) box.getSelectedItem();
			box.setModel(new javax.swing.DefaultComboBoxModel<>(new java.util.Vector<>(now)));
			for (T c : now) {
				if (chosen != null && c.getID().equals(chosen.getID())) {
					box.setSelectedItem(c);
					return false;
				}
			}
			return true;
		}

		private void onChange(DoubleModel... models) {
			for (DoubleModel m : models) {
				m.addChangeListener((StateChangeListener) e -> refresh());
			}
		}

		// ---------------------------------------------------------------- parachute

		private JComponent parachuteTab() {
			JPanel p = new JPanel(new MigLayout("fill, gap rel unrel", "[][grow][]", ""));
			List<Parachute> chutes = Recovery.parachutes(rocket);
			if (chutes.isEmpty()) {
				p.add(note("The design has no parachute. Add one (Recovery: Parachute) inside a body tube, then size it here."), "span");
				refreshers.add(() -> {
				});
				return p;
			}
			JComboBox<Parachute> chute = new JComboBox<>(chutes.toArray(new Parachute[0]));
			chute.setRenderer(new DefaultListCellRenderer() {
				@Override
				public Component getListCellRendererComponent(JList<?> list, Object value, int index, boolean selected, boolean focus) {
					Parachute c = (Parachute) value;
					String text = c == null ? "" : c.getName() + "  (" + c.getStage().getName() + ", now " + length(c.getDiameter()) + ")";
					return super.getListCellRendererComponent(list, text, index, selected, focus);
				}
			});
			// The largest: usually the main.
			Parachute largest = chutes.stream().max((a, b) -> Double.compare(a.getDiameter(), b.getDiameter())).get();
			chute.setSelectedItem(largest);
			DoubleModel cd = new DoubleModel(largest.getCD(), UnitGroup.UNITS_COEFFICIENT, 0.05, 3);
			DoubleModel rate = new DoubleModel(5, UnitGroup.UNITS_VELOCITY, 0.5, 100);
			DoubleModel altitude = new DoubleModel(launchAltitude(), UnitGroup.UNITS_DISTANCE, -500, 6000);
			JCheckBox others = new JCheckBox();
			others.setSelected(true);
			JCheckBox ownMass = new JCheckBox("Another mass:");
			DoubleModel massModel = new DoubleModel(1, UnitGroup.UNITS_MASS, 0.001, 1000);
			JLabel diameter = result();
			JLabel detail = new JLabel(" ");
			JLabel now = new JLabel(" ");
			JButton apply = new JButton("Apply");
			JButton main = new JButton("Main: 5 m/s");
			JButton drogue = new JButton("Drogue: 25 m/s");
			main.addActionListener(e -> rate.setValue(5));
			drogue.addActionListener(e -> rate.setValue(25));

			p.add(new JLabel("Parachute:"));
			p.add(chute, "span, growx, wrap");
			p.add(new JLabel("Drag coefficient:"));
			p.add(spinner(cd), "w 80lp, wrap");
			p.add(new JLabel("Descent rate wanted:"));
			p.add(spinner(rate), "w 80lp, split 4");
			p.add(new UnitSelector(rate));
			p.add(main, "gapleft para");
			p.add(drogue, "wrap");
			p.add(new JLabel("Landing site altitude:"));
			p.add(spinner(altitude), "w 80lp, split 2");
			p.add(new UnitSelector(altitude), "wrap");
			p.add(new JLabel("It brings down:"));
			p.add(ownMass, "split 3");
			p.add(spinner(massModel), "w 80lp");
			p.add(new UnitSelector(massModel), "wrap");
			p.add(others, "skip, span, wrap");
			p.add(new JSeparator(), "span, growx, wrap para");
			p.add(new JLabel("Diameter:"));
			p.add(diameter, "split 2");
			p.add(apply, "gapleft para, wrap");
			p.add(detail, "skip, span, wrap");
			p.add(now, "skip, span, wrap para");
			p.add(note("The descent rate under the parachute fully open, in still air of the standard atmosphere at the landing site; "
					+ "OpenRocket's simulation also counts the rocket's own drag, so it lands a little slower. What it brings down is "
					+ "its stage after burnout (motor cases and all), with the parachute itself at that size. Usual rates: 4.5–6 m/s "
					+ "(15–20 ft/s) under a main, 20–30 m/s (65–100 ft/s) under a drogue. Competitions such as Spaceport America Cup "
					+ "limit each separate section to 75 ft·lbf (102 J) at landing."), "span");

			chute.addActionListener(e -> {
				Parachute c = (Parachute) chute.getSelectedItem();
				if (c != null) {
					cd.setValue(c.getCD());
				}
				refresh();
			});
			others.addActionListener(e -> refresh());
			ownMass.addActionListener(e -> refresh());
			onChange(cd, rate, altitude, massModel);
			apply.addActionListener(e -> {
				Parachute c = (Parachute) chute.getSelectedItem();
				double d = (Double) apply.getClientProperty("diameter");
				doc.addUndoPosition(RECOVERY + ": parachute size");
				c.setDiameter(d);
				if (Math.abs(c.getCD() - cd.getValue()) > 1e-9) {
					c.setCD(cd.getValue());
				}
			});
			refreshers.add(() -> {
				boolean other = keepCurrent(chute, Recovery.parachutes(rocket));
				Parachute c = (Parachute) chute.getSelectedItem();
				if (c == null || c.getRoot() != rocket) {
					return;
				}
				if (other) {
					cd.setValue(c.getCD());
				}
				chute.repaint();
				Recovery.ParachuteCase pc = Recovery.parachute(c, rocket.getSelectedConfiguration());
				others.setVisible(!pc.others.isEmpty());
				others.setText("Count " + String.join(", ", pc.others) + " (in its stage, open at landing too)");
				double rho = Recovery.airDensity(altitude.getValue());
				boolean withOthers = others.isSelected() && others.isVisible();
				if (!ownMass.isSelected()) {
					massModel.setValue(pc.mass(c.getDiameter()));
				}
				double m = ownMass.isSelected() ? massModel.getValue() : Double.NaN;
				double d = pc.diameterFor(rate.getValue(), cd.getValue(), rho, withOthers, m);
				double nowRate = pc.rate(c.getDiameter(), cd.getValue(), rho, withOthers, m);
				double nowMass = ownMass.isSelected() ? m : pc.mass(c.getDiameter());
				now.setText(String.format(Locale.ROOT, "Now %s: %s at %s, landing with %s.", length(c.getDiameter()),
						UnitGroup.UNITS_VELOCITY.getDefaultUnit().toStringUnit(nowRate), mass(nowMass), energy(nowMass, nowRate)));
				if (Double.isNaN(d)) {
					diameter.setText("none");
					detail.setText(wrapped(esc(String.join(", ", pc.others)) + " alone bring" + (pc.others.size() == 1 ? "s" : "")
							+ " it down slower than that."));
					apply.setVisible(false);
					return;
				}
				apply.setVisible(true);
				double newMass = ownMass.isSelected() ? m : pc.mass(d);
				diameter.setText(length(d));
				detail.setText(String.format(Locale.ROOT, "Brings down %s, landing with %s; air %.3f kg/m³.", mass(newMass),
						energy(newMass, rate.getValue()), rho));
				apply.setText("Set " + c.getName() + " to " + length(d));
				apply.putClientProperty("diameter", d);
				apply.setEnabled(Math.abs(d - c.getDiameter()) > 1e-5 || Math.abs(c.getCD() - cd.getValue()) > 1e-9);
			});
			return p;
		}

		/** A tube, told apart from others of the same name by where it is and the recovery devices in it. */
		private String tubeName(BodyTube t) {
			List<String> in = new ArrayList<>();
			for (Parachute c : Recovery.parachutes(rocket)) {
				if (Recovery.tubeOf(c) == t) {
					in.add(c.getName());
				}
			}
			return t.getName() + "  (" + t.getStage().getName() + ", " + length(Recovery.front(t)) + " from the tip"
					+ (in.isEmpty() ? "" : "; " + String.join(", ", in)) + ")";
		}

		private static String energy(double kg, double v) {
			double j = 0.5 * kg * v * v;
			return String.format(Locale.ROOT, "%.0f J (%.0f ft·lbf)", j, j / 1.3558179483314004);
		}

		private double launchAltitude() {
			for (Simulation s : doc.getSimulations()) {
				return s.getOptions().getLaunchAltitude();
			}
			return 0;
		}

		// ---------------------------------------------------------------- ejection charge

		private JComponent ejectionTab() {
			JPanel p = new JPanel(new MigLayout("fill, gap rel unrel", "[][grow][]", ""));
			List<BodyTube> tubes = Recovery.tubes(rocket);
			if (tubes.isEmpty()) {
				p.add(note("The design has no body tube to make a bay of."), "span");
				refreshers.add(() -> {
				});
				return p;
			}
			JComboBox<BodyTube> tube = new JComboBox<>(tubes.toArray(new BodyTube[0]));
			tube.setRenderer(new DefaultListCellRenderer() {
				@Override
				public Component getListCellRendererComponent(JList<?> list, Object value, int index, boolean selected, boolean focus) {
					return super.getListCellRendererComponent(list, value == null ? "" : tubeName((BodyTube) value), index, selected, focus);
				}
			});
			List<Parachute> chutes = Recovery.parachutes(rocket);
			BodyTube first = chutes.isEmpty() ? null
					: Recovery.tubeOf(chutes.stream().max((a, b) -> Double.compare(a.getDiameter(), b.getDiameter())).get());
			tube.setSelectedItem(first != null ? first : tubes.get(0));
			DoubleModel diameter = new DoubleModel(0.05, UnitGroup.UNITS_LENGTH, 0.001, 2);
			DoubleModel bayLength = new DoubleModel(0.1, UnitGroup.UNITS_LENGTH, 0.001, 10);
			DoubleModel pressure = new DoubleModel(15 * 6894.757293168, UnitGroup.UNITS_PRESSURE, 1000, 2e6);
			Unit psi = UnitGroup.UNITS_PRESSURE.findApproximate("psi");
			if (psi != null) {
				pressure.setCurrentUnit(psi);
			}
			SpinnerNumberModel pinCount = new SpinnerNumberModel(2, 0, 12, 1);
			JComboBox<Object> pinType = new JComboBox<>(new Object[] { Recovery.ShearPin.NYLON_2_56, Recovery.ShearPin.NYLON_4_40, "Other" });
			pinType.setRenderer(new DefaultListCellRenderer() {
				@Override
				public Component getListCellRendererComponent(JList<?> list, Object value, int index, boolean selected, boolean focus) {
					String text = value instanceof Recovery.ShearPin pin ? String.format(Locale.ROOT, "%s (about %.0f lbf)", pin.label, pin.lbf)
							: "Other: its strength";
					return super.getListCellRendererComponent(list, text, index, selected, focus);
				}
			});
			DoubleModel strength = new DoubleModel(Recovery.ShearPin.NYLON_2_56.newtons, UnitGroup.UNITS_FORCE, 1, 10000);
			JSpinner strengthSpinner = spinner(strength);
			UnitSelector strengthUnit = new UnitSelector(strength);
			// Packed full by default: the usual case, and the side a charge should err on.
			JComboBox<Recovery.Packing> packing = new JComboBox<>(Recovery.Packing.values());
			packing.setRenderer(new DefaultListCellRenderer() {
				@Override
				public Component getListCellRendererComponent(JList<?> list, Object value, int index, boolean selected, boolean focus) {
					return super.getListCellRendererComponent(list, value == null ? "" : ((Recovery.Packing) value).label, index, selected, focus);
				}
			});
			JLabel found = new JLabel(" ");
			JButton fromDesign = new JButton("From the design");
			JLabel volume = new JLabel(" ");
			JLabel grams = result();
			JLabel basis = new JLabel(" ");
			JLabel push = new JLabel(" ");
			JLabel pins = new JLabel(" ");
			JButton usePins = new JButton("Use that");

			p.add(new JLabel("Bay in:"));
			p.add(tube, "span, growx, wrap");
			p.add(new JLabel("Inside diameter:"));
			p.add(spinner(diameter), "w 80lp, split 2");
			p.add(new UnitSelector(diameter), "wrap");
			p.add(new JLabel("Bay length:"));
			p.add(spinner(bayLength), "w 80lp, split 3");
			p.add(new UnitSelector(bayLength));
			p.add(fromDesign, "gapleft para, wrap");
			p.add(found, "skip, span, wrap");
			p.add(new JLabel("Pressure:"));
			p.add(spinner(pressure), "w 80lp, split 2");
			p.add(new UnitSelector(pressure), "wrap");
			p.add(new JLabel("Shear pins:"));
			p.add(new JSpinner(pinCount), "w 50lp, split 5");
			p.add(new JLabel("×"));
			p.add(pinType);
			p.add(strengthSpinner, "w 70lp, hidemode 3");
			p.add(strengthUnit, "hidemode 3");
			p.add(new JLabel("Parachute:"), "newline");
			p.add(packing, "split 2");
			p.add(new JLabel("(with its shock cord)"), "wrap");
			p.add(new JSeparator(), "span, growx, wrap para");
			p.add(new JLabel("Black powder:"));
			p.add(grams, "wrap");
			p.add(basis, "skip, span, wrap");
			p.add(volume, "skip, span, wrap");
			p.add(push, "skip, span, wrap");
			p.add(pins, "skip, span, split 2");
			p.add(usePins, "hidemode 3");
			p.add(note("FFFFg black powder for that pressure in the bay (the tube's inside between what closes it off), from the ideal gas law every charge "
					+ "calculator uses (22.16 ft·lbf/lbm·°R at 3307 °R), allowing for the parachute. A parachute packed in the bay soaks up much of the "
					+ "charge's heat: in T. Fetter's ground tests (NARCON 2025) a bay it filled needed about twice the usual sum, and rockets that failed "
					+ "to deploy on the usual sum flew on twice it. 10–15 psi is usual; the charge should push at least twice what the shear pins hold "
					+ "together (taken as nylon's strength over the thread root; tested pins often hold a little less). Bulkheads, centering rings, engine blocks, inner tubes and "
					+ "shoulders close off a bay; a coupler with no bulkhead counts as open. Ground-test every charge with the parachute and shock cord "
					+ "packed as they will fly."), "newline para, span");

			Runnable designBay = () -> {
				BodyTube t = (BodyTube) tube.getSelectedItem();
				if (t == null) {
					return;
				}
				// Around its recovery device, if it has one.
				RocketComponent device = null;
				for (Parachute c : Recovery.parachutes(rocket)) {
					if (Recovery.tubeOf(c) == t) {
						device = c;
					}
				}
				Recovery.Bay bay = device != null ? Recovery.bayOf(device) : Recovery.bay(t, Double.NaN);
				diameter.setValue(bay.diameter);
				bayLength.setValue(bay.length());
				found.setText(String.format(Locale.ROOT, "In the design: %s from %s to %s of %s%s.", length(bay.length()), length(bay.from),
						length(bay.to), t.getName(), device != null ? ", around " + device.getName() : ""));
			};
			tube.addActionListener(e -> {
				designBay.run();
				refresh();
			});
			fromDesign.addActionListener(e -> {
				designBay.run();
				refresh();
			});
			pinType.addActionListener(e -> {
				if (pinType.getSelectedItem() instanceof Recovery.ShearPin pin) {
					strength.setValue(pin.newtons);
				}
				refresh();
			});
			pinCount.addChangeListener(e -> refresh());
			packing.addActionListener(e -> refresh());
			onChange(diameter, bayLength, pressure, strength);
			usePins.addActionListener(e -> pressure.setValue((Double) usePins.getClientProperty("pressure")));
			designBay.run();
			refreshers.add(() -> {
				if (keepCurrent(tube, Recovery.tubes(rocket))) {
					designBay.run();
				}
				tube.repaint();
				boolean other = !(pinType.getSelectedItem() instanceof Recovery.ShearPin);
				strengthSpinner.setVisible(other);
				strengthUnit.setVisible(other);
				double d = diameter.getValue(), v = Math.PI * d * d / 4 * bayLength.getValue();
				double pa = pressure.getValue();
				Recovery.Packing packed = (Recovery.Packing) packing.getSelectedItem();
				double ideal = Recovery.blackPowder(pa, v) * 1000;
				grams.setText(String.format(Locale.ROOT, "%.2f g", Recovery.charge(pa, v, packed) * 1000));
				basis.setText(switch (packed) {
					case FULL -> String.format(Locale.ROOT, "Twice the ideal gas law's %.2f g, for a parachute that fills the bay.", ideal);
					case HALF -> "The ideal gas law's amount, for a parachute filling the half of the bay by the charge.";
					case SMALL -> String.format(Locale.ROOT, "Three quarters of the ideal gas law's %.2f g: little of the parachute is near the charge.", ideal);
				});
				volume.setText(imperial() ? String.format(Locale.ROOT, "Bay volume %.1f in³.", v / 1.6387064e-5)
						: String.format(Locale.ROOT, "Bay volume %.0f cm³.", v * 1e6));
				double force = pa * Math.PI * d * d / 4;
				push.setText(String.format(Locale.ROOT, "It pushes the bulkhead with %.0f N (%.0f lbf).", force, force / 4.4482216152605));
				int n = (Integer) pinCount.getValue();
				double each = strength.getValue();
				if (n == 0) {
					pins.setText("No shear pins: friction alone holds the joint.");
					usePins.setVisible(false);
					return;
				}
				double needed = Recovery.pressureForPins(n, each, d);
				boolean enough = pa >= needed - 1e-6;
				String unit = pressure.getCurrentUnit().getUnit();
				pins.setText(String.format(Locale.ROOT, "%s %d pin%s with twice their strength%s", enough ? "Breaks" : "Too little for", n,
						n == 1 ? "" : "s", enough ? "." : String.format(Locale.ROOT, ": %s (%.2f g) does that.",
								pressure.getCurrentUnit().toStringUnit(needed), Recovery.charge(needed, v, packed) * 1000)));
				pins.setForeground(enough ? labelColor() : GUIUtil.getUITheme().getErrorColor());
				usePins.setVisible(!enough);
				usePins.putClientProperty("pressure", needed);
				usePins.setToolTipText("Set the pressure to " + pressure.getCurrentUnit().toStringUnit(needed) + " (" + unit + ")");
			});
			return p;
		}

		// ---------------------------------------------------------------- ballast (nose weight)

		private JComponent ballastPanel() {
			JPanel p = new JPanel(new MigLayout("fill, gap rel unrel", "[][grow][]", "[][][][]para[grow][][]"));
			// Looked up again each time: undo and redo put new copies of the parts in the design.
			RocketComponent first = Recovery.noseOf(rocket);
			if (first == null) {
				p.add(note("The design has nothing to put weight in yet."), "span");
				refreshers.add(() -> {
				});
				return p;
			}
			DoubleModel target = new DoubleModel(1.5, UnitGroup.UNITS_COEFFICIENT, 0, 20);
			DoubleModel at = new DoubleModel(first.getLength() / 3, UnitGroup.UNITS_LENGTH, 0, first.getLength());
			JLabel where = new JLabel(" ");
			JLabel answer = result();
			JLabel detail = new JLabel(" ");
			JButton apply = new JButton("Apply");
			List<Object[]> rows = new ArrayList<>();
			AbstractTableModel table = new AbstractTableModel() {
				private final String[] columns = { "Motor configuration", "Stability now", "Nose weight for the target" };

				@Override
				public int getRowCount() {
					return rows.size();
				}

				@Override
				public int getColumnCount() {
					return 3;
				}

				@Override
				public String getColumnName(int c) {
					return columns[c];
				}

				@Override
				public Object getValueAt(int r, int c) {
					return rows.get(r)[c];
				}
			};
			JTable t = new JTable(table);
			t.setRowSelectionAllowed(false);
			JScrollPane scroll = new JScrollPane(t);
			scroll.setPreferredSize(new java.awt.Dimension(470, 135));

			p.add(new JLabel("Stability wanted:"));
			p.add(spinner(target), "w 70lp, split 2");
			p.add(new JLabel("calibers"), "wrap");
			p.add(new JLabel("Weight's centre:"));
			p.add(spinner(at), "w 80lp, split 3");
			p.add(new UnitSelector(at));
			p.add(new JLabel("from the nose tip"), "wrap");
			p.add(where, "skip, span, wrap");
			p.add(scroll, "span, grow, wrap");
			p.add(answer, "span, split 2");
			p.add(apply, "gapleft para, wrap");
			p.add(detail, "span, wrap para");
			p.add(note("Stability as the design view shows it (centre of pressure at Mach " + Application.getPreferences().getDefaultMach()
					+ ", centre of gravity at launch), for each motor configuration; the weight is the most any of them needs, so every "
					+ "one has at least the stability wanted. A weight these helpers added before counts as not there. Every gram "
					+ "costs some apogee. The usual margin is 1–2 calibers."), "span");

			onChange(target, at);
			apply.addActionListener(e -> {
				double kg = (Double) apply.getClientProperty("weight");
				RocketComponent nose = Recovery.noseOf(rocket);
				doc.addUndoPosition(BALLAST + ": nose weight");
				Recovery.setNoseWeight(nose, kg, Math.min(at.getValue(), nose.getLength()));
			});
			refreshers.add(() -> {
				RocketComponent nose = Recovery.noseOf(rocket);
				if (nose == null) {
					return;
				}
				MassComponent old = Recovery.noseWeightIn(nose);
				where.setText(String.format(Locale.ROOT, "Inside %s (%s long)%s.", nose.getName(), length(nose.getLength()),
						old != null ? String.format(Locale.ROOT, "; its %s now: %s", Recovery.NOSE_WEIGHT.toLowerCase(Locale.ROOT), mass(old.getComponentMass())) : ""));
				double x = Recovery.front(nose) + Math.min(at.getValue(), nose.getLength());
				rows.clear();
				double most = 0;
				boolean reachable = true, moves = false;
				List<Recovery.Response> responses = Recovery.responses(rocket, x);
				for (Recovery.Response r : responses) {
					double w = r.weightFor(target.getValue());
					double now = Recovery.stability(rocket.getFlightConfiguration(r.without.config.getFlightConfigurationID())).margin();
					rows.add(new Object[] { r.without.config.getName(), String.format(Locale.ROOT, "%.2f cal", now),
							Double.isNaN(w) ? "cannot reach it there" : mass(w) });
					moves |= !r.noEffect();
					if (Double.isNaN(w)) {
						reachable = false;
					} else {
						most = Math.max(most, w);
					}
				}
				table.fireTableDataChanged();
				RocketComponent overridden = Recovery.massOverriddenAround(nose);
				String massNote = overridden == null ? ""
						: " " + esc(overridden.getName()) + "'s mass is overridden along with what is in it, so the weight moves the centre of gravity but adds no mass.";
				if (responses.isEmpty()) {
					answer.setText("No motor configurations");
					detail.setText("Give the design a motor (Motors & Configuration) to work out its stability.");
					apply.setEnabled(false);
				} else if (!moves && !reachable) {
					answer.setText("Weight there changes nothing");
					detail.setText(wrapped("The mass and centre of gravity of what is around it are overridden, along with what is in them."));
					apply.setEnabled(false);
				} else if (!reachable) {
					answer.setText("Not reachable with weight there");
					detail.setText(wrapped("Move the weight further forward, or ask for less stability." + massNote));
					apply.setEnabled(false);
				} else if (most == 0) {
					answer.setText("No nose weight needed");
					detail.setText(String.format(Locale.ROOT, "Every configuration has at least %.2f calibers.", target.getValue()));
					apply.setText(old != null ? "Take out the " + Recovery.NOSE_WEIGHT.toLowerCase(Locale.ROOT) : "Apply");
					apply.setEnabled(old != null);
				} else {
					answer.setText(mass(most));
					detail.setText(wrapped(String.format(Locale.ROOT, "Centred %s from the tip, for at least %.2f calibers with every motor configuration.",
							esc(length(at.getValue())), target.getValue()) + massNote));
					apply.setText(old == null ? "Add it to " + nose.getName() : "Change the " + Recovery.NOSE_WEIGHT.toLowerCase(Locale.ROOT) + " to it");
					apply.setEnabled(old == null || Math.abs(old.getComponentMass() - most) > 1e-6);
				}
				apply.putClientProperty("weight", most);
			});
			return p;
		}
	}

	/** The look and feel's usual label colour. */
	private static Color labelColor() {
		Color c = javax.swing.UIManager.getColor("Label.foreground");
		return c != null ? c : Color.BLACK;
	}
}
