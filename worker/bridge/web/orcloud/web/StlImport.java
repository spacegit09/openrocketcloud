package orcloud.web;

import java.awt.Color;
import java.awt.Font;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Supplier;

import javax.swing.AbstractButton;
import javax.swing.ButtonGroup;
import javax.swing.JButton;
import javax.swing.JCheckBox;
import javax.swing.JComboBox;
import javax.swing.JComponent;
import javax.swing.JDialog;
import javax.swing.JLabel;
import javax.swing.JMenu;
import javax.swing.JMenuBar;
import javax.swing.JMenuItem;
import javax.swing.JPanel;
import javax.swing.JRadioButton;
import javax.swing.JSeparator;
import javax.swing.JSpinner;
import javax.swing.SpinnerNumberModel;
import javax.swing.SwingUtilities;

import info.openrocket.core.database.Databases;
import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.material.Material;
import info.openrocket.core.rocketcomponent.BodyTube;
import info.openrocket.core.rocketcomponent.InnerTube;
import info.openrocket.core.rocketcomponent.MassComponent;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.startup.Application;
import info.openrocket.core.unit.Unit;
import info.openrocket.core.unit.UnitGroup;
import info.openrocket.swing.gui.main.BasicFrame;
import net.miginfocom.swing.MigLayout;
import orcloud.stl.StlModel;
import orcloud.stl.StlPart;

/**
 * "Import 3D model (STL)..." in OpenRocket's Tools menu (browser version). An STL file is a bare
 * surface mesh, so the dialog asks for what it cannot say (units, orientation, material, how the
 * part is made) and the model then gives either a new mass component or the mass and centre of
 * gravity of the selected component, both standard OpenRocket data. Aerodynamics keep coming from
 * OpenRocket's own component shapes (see {@link StlPart}). Parachutes, streamers and shock cords
 * are not modelled from files.
 *
 * The dialog is not modal, like OpenRocket's component dialogs: CheerpJ updates the screen when a
 * click has been handled, which a modal dialog delays until it closes. The file is chosen from
 * inside it, so no window opens after the browser's file chooser.
 */
public final class StlImport {
	private static final String TITLE = "Import 3D model (STL)";

	private StlImport() {
	}

	/** Asks the page for a file (Java cannot see the user's files): "path\nname", "!" + a message, or null. */
	private static native String jsPickStl();

	/** Adds the menu item. `selected` gives the component selected in the design's tree, or null. */
	public static void install(BasicFrame frame, OpenRocketDocument doc, Supplier<RocketComponent> selected) {
		JMenuItem item = new JMenuItem(TITLE + "...");
		item.addActionListener(e -> new ImportDialog(frame, doc, selected.get()).setVisible(true));
		JMenuBar bar = frame.getJMenuBar();
		String tools = Application.getTranslator().get("main.menu.tools");
		for (int i = 0; i < bar.getMenuCount(); i++) {
			JMenu m = bar.getMenu(i);
			if (m != null && tools.equals(m.getText())) {
				m.addSeparator();
				m.add(item);
				return;
			}
		}
		JMenu menu = new JMenu("3D model");
		menu.add(item);
		bar.add(menu);
	}

	/** A material: a name and a density in kg/m³ (NaN for "enter the density"). */
	private record Choice(String name, double density) {
		@Override
		public String toString() {
			return Double.isNaN(density) ? name : String.format(Locale.ROOT, "%s, %.2f g/cm³", name, density / 1000);
		}
	}

	private static List<Choice> materials() {
		List<Choice> out = new ArrayList<>(List.of(
				new Choice("PLA (3D printing)", 1240), new Choice("PETG (3D printing)", 1270), new Choice("ABS (3D printing)", 1040),
				new Choice("ASA (3D printing)", 1070), new Choice("Nylon PA12 (3D printing)", 1010), new Choice("Polycarbonate (3D printing)", 1200),
				new Choice("Resin (SLA/DLP printing)", 1180)));
		for (Material m : Databases.BULK_MATERIAL) {
			out.add(new Choice(m.getName(), m.getDensity()));
		}
		out.add(new Choice("Other: enter the density", Double.NaN));
		return out;
	}

	private static final String[] UNITS = { "mm", "cm", "m", "in" };
	private static final double[] UNIT_METRES = { 0.001, 0.01, 1, 0.0254 };
	private static final String[] AXES = { "X", "Y", "Z" };

	private static final class ImportDialog extends JDialog {
		private final OpenRocketDocument doc;
		private final RocketComponent target;
		private final RocketComponent parent;
		private StlPart part;
		private String baseName;

		private final JButton choose = new JButton("Choose STL file...");
		private final JLabel file = new JLabel("No file chosen yet.");
		private final JComboBox<String> units = new JComboBox<>(UNITS);
		private final JLabel size = new JLabel();
		private final JComboBox<String> axis = new JComboBox<>(new String[] { "X axis", "Y axis", "Z axis" });
		private final JComboBox<String> front = new JComboBox<>();
		private final JComboBox<Choice> material = new JComboBox<>(materials().toArray(new Choice[0]));
		private final JSpinner density = spinner(1.24, 0.01, 30, 0.01);
		private final JRadioButton printed = new JRadioButton("3D printed: walls");
		private final JSpinner wall = spinner(1.2, 0.05, 50, 0.1);
		private final JSpinner infill = spinner(20, 0, 100, 5);
		private final JRadioButton solid = new JRadioButton("Solid");
		private final JRadioButton shell = new JRadioButton("Hollow shell (walls only)");
		private final JCheckBox known = new JCheckBox("Known mass:");
		private final JSpinner knownMass = spinner(10, 0.001, 100000, 1);
		private final JSpinner copies = spinner(1, 1, 100, 1);
		private final JRadioButton addNew = new JRadioButton();
		private final JSpinner offset = spinner(0, -10000, 10000, 1);
		private final JRadioButton setMass = new JRadioButton();
		private final JCheckBox setCg = new JCheckBox("and its centre of gravity", true);
		private final JLabel result = new JLabel("-");
		private final JLabel problems = new JLabel();
		private final JButton ok = new JButton("Import");
		private final List<JComponent> modelInputs = List.of(units, axis, front, material, printed, wall, infill, solid, shell, known, copies);

		ImportDialog(BasicFrame frame, OpenRocketDocument doc, RocketComponent selected) {
			super(frame, TITLE, false);
			this.doc = doc;
			this.target = selected;
			RocketComponent p = selected == null ? null : StlPart.massParentFor(selected);
			if (p == null) {
				for (RocketComponent c : doc.getRocket()) {
					if (c.isCompatible(MassComponent.class)) {
						p = c;
						break;
					}
				}
			}
			this.parent = p;

			JComponent pane = (JComponent) getContentPane();
			pane.setLayout(new MigLayout("fillx, ins dialog, wrap 2", "[right][grow,fill]"));
			pane.add(new JLabel("Model:"));
			pane.add(row(choose, file));
			pane.add(new JLabel("Units in the file:"));
			pane.add(row(units, size));
			pane.add(new JLabel("Along the rocket:"));
			pane.add(row(axis, new JLabel("  Nose-side end:"), front));

			pane.add(section("Mass"), "span, growx, gaptop para");
			pane.add(new JLabel("Material:"));
			pane.add(row(material, density, new JLabel("g/cm³")));
			pane.add(new JLabel("Made as:"));
			pane.add(row(printed, wall, new JLabel("mm, infill"), infill, new JLabel("%")));
			pane.add(new JLabel(""));
			pane.add(row(solid, shell));
			pane.add(new JLabel(""));
			pane.add(row(known, knownMass, new JLabel("g, used instead of material and fill")));
			pane.add(new JLabel("Copies:"));
			pane.add(row(copies, new JLabel("identical parts in this component, e.g. 3 for a fin set from a model of one fin")));

			pane.add(section("Use it for"), "span, growx, gaptop para");
			addNew.setText(parent == null ? "A new mass component (this design has no part to put it in)"
					: "A new mass component inside \"" + parent.getName() + "\",");
			pane.add(row(addNew, offset, new JLabel("mm below its top")), "span");
			boolean canSet = StlPart.canSetMassOf(selected);
			setMass.setText(selected == null ? "The mass of the selected component (select one in the tree first)"
					: StlPart.isRecoveryItem(selected) ? "The mass of \"" + selected.getName() + "\" (not for parachutes, streamers and shock cords)"
					: canSet ? "The mass of \"" + selected.getName() + "\"" : "The mass of \"" + selected.getName() + "\" (not possible for this item)");
			pane.add(row(setMass, setCg), "span");

			pane.add(new JSeparator(), "span, growx, gaptop para");
			pane.add(new JLabel("Result:"));
			pane.add(result);
			problems.setForeground(new Color(0xC0, 0x30, 0x20));
			pane.add(problems, "skip, hidemode 3");
			JLabel note = new JLabel("<html>OpenRocket computes aerodynamics from its own component shapes; the model sets mass and balance only.</html>");
			note.setFont(note.getFont().deriveFont(note.getFont().getSize2D() - 1f));
			note.setForeground(Color.GRAY);
			pane.add(note, "span, growx, wmin 10");
			JButton cancel = new JButton("Cancel");
			pane.add(cancel, "span, split 2, right, tag cancel, gaptop para");
			pane.add(ok, "tag ok");

			group(printed, solid, shell);
			group(addNew, setMass);
			addNew.setEnabled(parent != null);
			setMass.setEnabled(canSet);
			// Tubes usually hold the part; anything else selected is usually the part itself.
			boolean container = selected instanceof BodyTube || selected instanceof InnerTube;
			if (canSet && (!container || parent == null)) {
				setMass.setSelected(true);
			} else if (parent != null) {
				addNew.setSelected(true);
			}
			printed.setSelected(true);
			fillFront();

			axis.addActionListener(e -> {
				if (part != null) {
					part.axis = axis.getSelectedIndex();
					part.frontAtMax = StlPart.defaultFrontAtMax(part.model, part.axis);
					fillFront();
					front.setSelectedIndex(part.frontAtMax ? 1 : 0);
				}
				update();
			});
			material.addActionListener(e -> {
				Choice c = (Choice) material.getSelectedItem();
				density.setEnabled(part != null && c != null && Double.isNaN(c.density()));
				if (c != null && !Double.isNaN(c.density())) {
					density.setValue(c.density() / 1000);
				}
			});
			for (JComboBox<?> c : List.of(units, front, material)) {
				c.addActionListener(e -> update());
			}
			for (JSpinner s : List.of(density, wall, infill, knownMass, copies, offset)) {
				s.addChangeListener(e -> update());
			}
			for (AbstractButton b : List.of(printed, solid, shell, known, addNew, setMass, setCg)) {
				b.addActionListener(e -> update());
			}
			choose.addActionListener(e -> chooseFile());
			cancel.addActionListener(e -> dispose());
			ok.addActionListener(e -> apply());
			getRootPane().setDefaultButton(ok);
			material.setSelectedIndex(0);
			update();
			pack();
			setLocationRelativeTo(frame);
		}

		/** The browser's file chooser answers asynchronously: wait for it, and read the file, off the UI thread. */
		private void chooseFile() {
			choose.setEnabled(false);
			Thread t = new Thread(() -> {
				String picked = jsPickStl();
				if (picked == null) {
					SwingUtilities.invokeLater(() -> choose.setEnabled(true));
					return;
				}
				if (picked.startsWith("!")) {
					SwingUtilities.invokeLater(() -> failed(picked.substring(1)));
					return;
				}
				String[] parts = picked.split("\n", 2);
				String name = parts.length > 1 ? parts[1] : "model.stl";
				try {
					StlModel model = StlModel.read(Files.readAllBytes(Path.of(parts[0])));
					SwingUtilities.invokeLater(() -> load(name, model));
				} catch (Exception e) {
					SwingUtilities.invokeLater(() -> failed("Could not read " + name + ": " + e.getMessage()));
				}
			}, "stl-import");
			t.setDaemon(true);
			t.start();
		}

		private void failed(String message) {
			choose.setEnabled(true);
			part = null;
			file.setText(message);
			update();
		}

		private void load(String name, StlModel model) {
			choose.setEnabled(true);
			choose.setText("Choose another...");
			baseName = name.replaceAll("(?i)\\.stl$", "");
			part = new StlPart(model);
			file.setText(name + ": " + String.format(Locale.ROOT, "%,d", model.triangles) + " triangles, "
					+ (model.closed ? "a closed solid" : "an open surface (not watertight)"));
			int guessedAxis = part.axis;
			boolean guessedFront = part.frontAtMax;
			axis.setSelectedIndex(guessedAxis);
			fillFront();
			front.setSelectedIndex(guessedFront ? 1 : 0);
			solid.setEnabled(model.closed);
			printed.setEnabled(model.closed);
			(model.closed ? printed : shell).setSelected(true);
			update();
		}

		private void fillFront() {
			String a = AXES[axis.getSelectedIndex()];
			int was = front.getSelectedIndex();
			front.removeAllItems();
			front.addItem("lowest " + a);
			front.addItem("highest " + a);
			front.setSelectedIndex(Math.max(0, was));
		}

		private void update() {
			for (JComponent c : modelInputs) {
				c.setEnabled(part != null);
			}
			if (part != null) {
				solid.setEnabled(part.model.closed);
				printed.setEnabled(part.model.closed);
			}
			Choice m = (Choice) material.getSelectedItem();
			density.setEnabled(part != null && m != null && Double.isNaN(m.density()));
			knownMass.setEnabled(part != null && known.isSelected());
			wall.setEnabled(part != null && !solid.isSelected());
			infill.setEnabled(part != null && printed.isSelected());
			offset.setEnabled(addNew.isSelected());
			setCg.setEnabled(setMass.isSelected() && !(target instanceof MassComponent));

			List<String> issues = new ArrayList<>();
			if (part == null) {
				size.setText("");
				result.setText("-");
				issues.add("Choose the STL file of the part.");
			} else {
				int u = units.getSelectedIndex();
				part.unit = UNIT_METRES[u];
				part.axis = axis.getSelectedIndex();
				part.frontAtMax = front.getSelectedIndex() == 1;
				part.density = ((Number) density.getValue()).doubleValue() * 1000;
				part.fill = solid.isSelected() ? StlPart.Fill.SOLID : shell.isSelected() ? StlPart.Fill.SHELL : StlPart.Fill.PRINTED;
				part.wall = ((Number) wall.getValue()).doubleValue() / 1000;
				part.infill = ((Number) infill.getValue()).doubleValue() / 100;
				part.copies = ((Number) copies.getValue()).intValue();
				part.knownMass = known.isSelected() ? ((Number) knownMass.getValue()).doubleValue() / 1000 : Double.NaN;
				StlModel model = part.model;
				size.setText(String.format(Locale.ROOT, "  Size: %s × %s × %s %s", dim(model.size(0)), dim(model.size(1)), dim(model.size(2)), UNITS[u]));
				issues.addAll(part.problems());
			}
			if (!(addNew.isSelected() && addNew.isEnabled()) && !(setMass.isSelected() && setMass.isEnabled())) {
				issues.add("Choose what the model is for.");
			}
			boolean ready = issues.isEmpty();
			Unit len = UnitGroup.UNITS_LENGTH.getDefaultUnit();
			if (part != null && ready) {
				result.setText("Mass " + UnitGroup.UNITS_MASS.getDefaultUnit().toStringUnit(part.mass()) + ", centre of gravity "
						+ len.toStringUnit(part.cgFromFront()) + " from the nose-side end, length " + len.toStringUnit(part.length()));
				if (setMass.isSelected() && !(target instanceof MassComponent) && target.getLength() > 0
						&& Math.abs(part.length() - target.getLength()) > 0.1 * target.getLength()) {
					issues.add("Note: the model is " + len.toStringUnit(part.length()) + " long and \"" + target.getName() + "\" is "
							+ len.toStringUnit(target.getLength()) + ". Check the units and the nose-side end.");
				}
			} else if (part != null) {
				result.setText("-");
			}
			problems.setText(issues.isEmpty() ? "" : "<html>" + String.join("<br>", issues) + "</html>");
			problems.setVisible(!issues.isEmpty());
			ok.setEnabled(ready);
			if (isShowing()) {
				pack();
			}
		}

		private void apply() {
			// The design may have changed while the dialog was open.
			RocketComponent where = addNew.isSelected() ? parent : target;
			if (where == null || where.getRoot() != doc.getRocket()) {
				failed("\"" + (where == null ? "?" : where.getName()) + "\" is no longer in the design. Close this and import again.");
				return;
			}
			doc.addUndoPosition(TITLE);
			if (addNew.isSelected()) {
				part.addTo(parent, baseName, ((Number) offset.getValue()).doubleValue() / 1000);
			} else {
				part.applyTo(target, setCg.isSelected());
			}
			dispose();
		}

		private static String dim(double v) {
			return String.format(Locale.ROOT, v >= 100 ? "%.0f" : v >= 10 ? "%.1f" : "%.2f", v);
		}

		private static JSpinner spinner(double value, double min, double max, double step) {
			JSpinner s = new JSpinner(new SpinnerNumberModel(value, min, max, step));
			s.setEditor(new JSpinner.NumberEditor(s, step >= 1 ? "0" : "0.0##"));
			return s;
		}

		private static JComponent row(JComponent... parts) {
			JPanel p = new JPanel(new MigLayout("ins 0", ""));
			for (JComponent c : parts) {
				p.add(c);
			}
			return p;
		}

		private static JComponent section(String title) {
			JLabel l = new JLabel(title);
			l.setFont(l.getFont().deriveFont(Font.BOLD));
			return l;
		}

		private static void group(JRadioButton... buttons) {
			ButtonGroup g = new ButtonGroup();
			for (JRadioButton b : buttons) {
				g.add(b);
			}
		}
	}
}
