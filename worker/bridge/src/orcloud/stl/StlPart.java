package orcloud.stl;

import java.util.ArrayList;
import java.util.List;

import info.openrocket.core.rocketcomponent.ComponentAssembly;
import info.openrocket.core.rocketcomponent.MassComponent;
import info.openrocket.core.rocketcomponent.RecoveryDevice;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.rocketcomponent.ShockCord;
import info.openrocket.core.rocketcomponent.position.AxialMethod;

/**
 * A 3D model as a rocket part: the model's measurements plus what an STL file cannot say (its
 * units, which axis runs along the rocket and which end faces the nose, the material, and how the
 * part is made), giving its mass, centre of gravity, length and radius in SI units.
 *
 * Only mass and balance are taken from the model. OpenRocket's aerodynamics need its own component
 * shapes (shape families, fin planforms); a mesh converted to them gave drag errors of up to 20%
 * that do not shrink with a finer mesh, so the shapes stay as modelled in OpenRocket.
 */
public final class StlPart {
	/** How the part is made: printed (walls plus infill), solid, or a hollow shell (walls only). */
	public enum Fill {
		PRINTED, SOLID, SHELL
	}

	public final StlModel model;
	/** Metres per file unit. */
	public double unit = 0.001;
	/** The model axis that runs along the rocket (0 = x, 1 = y, 2 = z). */
	public int axis;
	/** Whether the nose-side end is at the axis' high end. */
	public boolean frontAtMax;
	/** kg/m³. */
	public double density = 1240;
	public Fill fill = Fill.PRINTED;
	/** Wall thickness in metres (printed and shell). */
	public double wall = 0.0012;
	/** Infill fraction, 0..1 (printed). */
	public double infill = 0.2;
	/** Identical copies in the part (a fin set from a model of one fin). */
	public int copies = 1;
	/** A known mass in kg for one copy, used instead of material and fill; NaN when not given. */
	public double knownMass = Double.NaN;

	public StlPart(StlModel model) {
		this.model = model;
		axis = longestAxis(model);
		frontAtMax = defaultFrontAtMax(model, axis);
	}

	/** The model's longest dimension, usually the one along a rocket part. */
	public static int longestAxis(StlModel m) {
		int a = 0;
		for (int i = 1; i < 3; i++) {
			if (m.size(i) > m.size(a)) {
				a = i;
			}
		}
		return a;
	}

	/**
	 * The nose-side end is guessed as the end farther from the centre of gravity, which suits nose
	 * cones and most tapered parts; symmetric parts default to the low end.
	 */
	public static boolean defaultFrontAtMax(StlModel m, int axis) {
		double c = (m.closed ? m.volumeCentroid : m.areaCentroid)[axis];
		double toMin = c - m.min[axis];
		double toMax = m.max[axis] - c;
		return toMax > toMin * 1.05;
	}

	public boolean canBeSolid() {
		return model.closed;
	}

	public double length() {
		return model.size(axis) * unit;
	}

	/** Half the larger of the two cross dimensions. */
	public double radius() {
		double r = 0;
		for (int i = 0; i < 3; i++) {
			if (i != axis) {
				r = Math.max(r, model.size(i) / 2);
			}
		}
		return r * unit;
	}

	private double fromFront(double coordinate) {
		return (frontAtMax ? model.max[axis] - coordinate : coordinate - model.min[axis]) * unit;
	}

	/** Volume of material in one copy (m³). */
	public double materialVolume() {
		double v = model.volume * unit * unit * unit;
		double shell = model.area * unit * unit * wall;
		switch (fill) {
		case SOLID:
			return v;
		case SHELL:
			return model.closed ? Math.min(shell, v) : shell;
		default:
			double s = Math.min(shell, v);
			return s + infill * (v - s);
		}
	}

	public double mass() {
		double one = Double.isNaN(knownMass) ? density * materialVolume() : knownMass;
		return one * copies;
	}

	/** Centre of gravity from the nose-side end (m). */
	public double cgFromFront() {
		double solidCg = fromFront(model.volumeCentroid[axis]);
		double surfaceCg = fromFront(model.areaCentroid[axis]);
		if (!model.closed) {
			return surfaceCg; // only the surface is known
		}
		double v = model.volume * unit * unit * unit;
		double s = model.area * unit * unit * wall;
		if (fill == Fill.SOLID || s >= v) {
			return solidCg; // (walls thicker than the part make it solid)
		}
		if (fill == Fill.SHELL) {
			return surfaceCg;
		}
		// Printed: walls at the surface's centroid, infill in the rest of the volume.
		double inner = (v * solidCg - s * surfaceCg) / (v - s);
		double infillVolume = infill * (v - s);
		return (s * surfaceCg + infillVolume * inner) / (s + infillVolume);
	}

	/** What keeps the result from being trustworthy, for the dialog. */
	public List<String> problems() {
		List<String> out = new ArrayList<>();
		if (!model.closed && fill != Fill.SHELL && Double.isNaN(knownMass)) {
			out.add("The model is not a closed solid, so its volume is unknown: choose \"hollow shell\" or enter the mass.");
		}
		if (length() <= 0) {
			out.add("The model has no length along the chosen axis.");
		}
		if (!(mass() > 0)) {
			out.add("The mass comes out as zero.");
		}
		return out;
	}

	// ------------------------------------------------------------------ OpenRocket components

	/** Parachutes, streamers and shock cords are fabric and cord: a 3D model cannot describe them. */
	public static boolean isRecoveryItem(RocketComponent c) {
		return c instanceof RecoveryDevice || c instanceof ShockCord;
	}

	/** Whether the model can set this component's mass and centre of gravity. */
	public static boolean canSetMassOf(RocketComponent c) {
		return c != null && c.isMassive() && !isRecoveryItem(c) && !(c instanceof ComponentAssembly);
	}

	/** The component a new mass component would go into: the given one or its nearest ancestor that takes one. */
	public static RocketComponent massParentFor(RocketComponent c) {
		for (RocketComponent p = c; p != null; p = p.getParent()) {
			if (p.isCompatible(MassComponent.class)) {
				return p;
			}
		}
		return null;
	}

	/** Adds the model as a new mass component, `offset` metres below the top of `parent`. */
	public MassComponent addTo(RocketComponent parent, String name, double offset) {
		MassComponent mc = new MassComponent();
		mc.setName(name);
		addTo(parent, mc, offset);
		return mc;
	}

	/** Adds `mc`, a new mass component, sized and weighted as the model, `offset` metres below the top of `parent`. */
	public void addTo(RocketComponent parent, MassComponent mc, double offset) {
		parent.addChild(mc);
		mc.setAxialMethod(AxialMethod.TOP);
		mc.setAxialOffset(offset);
		shape(mc);
	}

	/** Gives a component the model's mass and (optionally) centre of gravity. */
	public void applyTo(RocketComponent c, boolean setCg) {
		if (!canSetMassOf(c)) {
			throw new IllegalArgumentException("A 3D model cannot set the mass of " + c.getName());
		}
		if (c instanceof MassComponent) {
			shape((MassComponent) c);
			return;
		}
		c.setMassOverridden(true);
		c.setOverrideMass(mass());
		if (setCg) {
			c.setCGOverridden(true);
			c.setOverrideCGX(cgFromFront());
		}
	}

	/** A mass component sized like the model, with its mass and, if off-centre, its centre of gravity. */
	private void shape(MassComponent mc) {
		fit(mc, 1);
		mc.setComponentMass(mass());
	}

	/**
	 * Sizes a mass component like the model `scale` times, with its centre of gravity if off-centre;
	 * the mass is left as it is (it does not depend on how the part lies).
	 */
	public void fit(MassComponent mc, double scale) {
		mc.setLength(length() * scale);
		mc.setRadiusAutomatic(false);
		double room = mc.getMaxParentRadius();
		mc.setRadius(room > 0 ? Math.min(radius() * scale, room) : radius() * scale);
		double cg = cgFromFront() * scale;
		boolean offCentre = Math.abs(cg - length() * scale / 2) > 1e-4;
		mc.setCGOverridden(offCentre);
		if (offCentre) {
			mc.setOverrideCGX(cg);
		}
	}
}
