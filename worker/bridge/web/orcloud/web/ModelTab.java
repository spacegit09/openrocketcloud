package orcloud.web;

import java.awt.Color;
import java.util.Base64;
import java.util.UUID;
import java.util.function.Consumer;

import javax.swing.JButton;
import javax.swing.JComboBox;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JSpinner;
import javax.swing.SwingUtilities;

import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.rocketcomponent.ComponentChangeEvent;
import info.openrocket.core.rocketcomponent.ComponentChangeListener;
import info.openrocket.core.rocketcomponent.MassComponent;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.unit.UnitGroup;
import info.openrocket.core.util.Invalidatable;
import info.openrocket.swing.gui.SpinnerEditor;
import info.openrocket.swing.gui.adaptors.DoubleModel;
import info.openrocket.swing.gui.components.BasicSlider;
import info.openrocket.swing.gui.components.UnitSelector;
import net.miginfocom.swing.MigLayout;
import orcloud.stl.PartMesh;
import orcloud.stl.PartMeshes;

/**
 * The "3D model" tab of a mass component's Edit dialog (browser version; added by our copy of
 * MassComponentConfig) for a component made from an imported 3D model:
 * <ul>
 * <li>Turning it about the rocket's axis sets the component's radial direction, OpenRocket's own
 * angle about the axis (also on the Radial position tab), so it is undone, shared, copied and saved
 * like any edit; mass and balance do not change.</li>
 * <li>Turning it end for end, or onto another of the file's axes, changes the stored shape and
 * fits the component's length, diameter and centre of gravity to it (its mass stays); OpenRocket's
 * undo restores the matching shape through {@link PartMeshes#restore}.</li>
 * </ul>
 * Changes apply at once and the dialog's undo step covers them, as for the dialog's other tabs.
 */
public final class ModelTab {
	public static final String TITLE = "3D model";
	private static final String[] AXES = { "X", "Y", "Z" };

	private ModelTab() {
	}

	/** After undo and redo (and reloads), shapes that were turned follow their components. */
	public static void install(OpenRocketDocument doc) {
		doc.getRocket().addComponentChangeListener(e -> {
			if (e.isUndoChange() && !PartMeshes.turned().isEmpty()) {
				SwingUtilities.invokeLater(() -> restoreShapes(doc));
			}
		});
	}

	private static void restoreShapes(OpenRocketDocument doc) {
		for (String id : PartMeshes.turned()) {
			RocketComponent c;
			try {
				c = doc.getRocket().findComponent(UUID.fromString(id));
			} catch (IllegalArgumentException e) {
				continue;
			}
			if (c instanceof MassComponent && PartMeshes.restore((MassComponent) c)) {
				// Part of the undo or redo: any other kind of change would make OpenRocket drop its redo steps.
				c.fireComponentChangeEvent(ComponentChangeEvent.UNDO_CHANGE);
			}
		}
	}

	/** Whether the component gets the tab: a mass component made from a 3D model. */
	public static boolean applies(RocketComponent c) {
		return c instanceof MassComponent && PartMeshes.get(c) != null;
	}

	/** The tab's content; `register` takes what must be released when the dialog closes. */
	public static JPanel panel(OpenRocketDocument doc, MassComponent part, Consumer<Invalidatable> register) {
		return new Panel(doc, part, register);
	}

	private static final class Panel extends JPanel {
		private final OpenRocketDocument doc;
		private final MassComponent part;
		private final JComboBox<String> axis = new JComboBox<>();
		private final JComboBox<String> front = new JComboBox<>();
		private boolean filling;

		Panel(OpenRocketDocument doc, MassComponent part, Consumer<Invalidatable> register) {
			super(new MigLayout("gap rel unrel", "[][65lp::][30lp::][]", ""));
			this.doc = doc;
			this.part = part;

			add(new JLabel("Turned about the rocket's axis:"));
			DoubleModel direction = new DoubleModel(part, "RadialDirection", UnitGroup.UNITS_ANGLE);
			register.accept(direction);
			JSpinner spin = new JSpinner(direction.getSpinnerModel());
			spin.setEditor(new SpinnerEditor(spin));
			add(spin, "growx");
			add(new UnitSelector(direction), "growx");
			add(new BasicSlider(direction.getSliderModel(-Math.PI, Math.PI)), "w 150lp, wrap");
			JButton left = new JButton("-90°"), right = new JButton("+90°");
			left.addActionListener(e -> turn(-Math.PI / 2));
			right.addActionListener(e -> turn(Math.PI / 2));
			add(row(left, right), "skip, span, wrap para");

			add(new JLabel("Lying along the rocket:"));
			for (String a : AXES) {
				axis.addItem(a + " axis of the file");
			}
			add(axis, "span 2, growx");
			JButton flip = new JButton("Turn end for end");
			flip.addActionListener(e -> front.setSelectedIndex(1 - front.getSelectedIndex()));
			add(flip, "wrap");
			add(new JLabel("Nose-side end:"));
			add(front, "span 2, growx, wrap para");

			// A set width, so the wrapped text is measured at it.
			JLabel note = new JLabel("<html><body style='width: 330px'>Turning about the axis is the component's radial direction"
					+ " (as on the Radial position tab); mass and balance stay. Turning it end for end or onto another axis fits"
					+ " its length, diameter and centre of gravity to the model; its mass stays.</body></html>");
			note.setFont(note.getFont().deriveFont(note.getFont().getSize2D() - 1f));
			note.setForeground(Color.GRAY);
			add(note, "span, wrap");

			fill();
			axis.addActionListener(e -> reorient());
			front.addActionListener(e -> reorient());
			// Shown as it is after undo, redo or a collaborator's change while the dialog is open.
			ComponentChangeListener refresh = e -> SwingUtilities.invokeLater(this::fill);
			part.addComponentChangeListener(refresh);
			register.accept(() -> part.removeComponentChangeListener(refresh));
		}

		/** Shows how the shape lies now; turning onto another axis needs the measurements kept since version 2. */
		private void fill() {
			PartMesh m = PartMeshes.get(part);
			if (m == null || filling) {
				return;
			}
			filling = true;
			axis.setSelectedIndex(m.axis);
			front.removeAllItems();
			front.addItem("lowest " + AXES[m.axis]);
			front.addItem("highest " + AXES[m.axis]);
			front.setSelectedIndex(m.frontAtMax ? 1 : 0);
			axis.setEnabled(m.part != null);
			axis.setToolTipText(m.part != null ? null : "Import the file again to lay this part along another axis");
			filling = false;
		}

		private void turn(double by) {
			part.setRadialDirection(Math.IEEEremainder(part.getRadialDirection() + by, 2 * Math.PI));
		}

		private void reorient() {
			if (filling || part.getRoot() != doc.getRocket()) {
				return;
			}
			PartMesh now = PartMeshes.get(part);
			String id = String.valueOf(part.getID());
			String data = PartMeshes.base64(id);
			if (now == null || data == null) {
				return;
			}
			int a = axis.getSelectedIndex();
			boolean f = front.getSelectedIndex() == 1;
			if (a == now.axis && f == now.frontAtMax) {
				return;
			}
			if (a != now.axis && now.part == null) {
				fill();
				return;
			}
			try {
				double scale = now.length > 0 ? part.getLength() / now.length : 1;
				PartMeshes.remember(part);
				PartMeshes.put(id, PartMesh.reorient(Base64.getDecoder().decode(data), a, f));
				PartMesh next = PartMeshes.get(part);
				if (next != null && next.part != null) {
					next.part.fit(part, scale);
				} else if (part.isCGOverridden()) {
					part.setOverrideCGX(part.getLength() - part.getOverrideCGX()); // end for end
				}
				PartMeshes.remember(part);
				part.fireComponentChangeEvent(ComponentChangeEvent.GRAPHIC_CHANGE);
			} catch (Exception e) {
				// leave the shape as it was
			}
			fill();
		}

		private static JPanel row(JButton... buttons) {
			JPanel p = new JPanel(new MigLayout("ins 0", ""));
			for (JButton b : buttons) {
				p.add(b);
			}
			return p;
		}
	}
}
