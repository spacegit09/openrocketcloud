package orcloud.recovery;

import java.util.ArrayList;
import java.util.List;

import info.openrocket.core.aerodynamics.BarrowmanCalculator;
import info.openrocket.core.aerodynamics.FlightConditions;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.masscalc.MassCalculator;
import info.openrocket.core.masscalc.RigidBody;
import info.openrocket.core.models.atmosphere.ExtendedISAModel;
import info.openrocket.core.rocketcomponent.AxialStage;
import info.openrocket.core.rocketcomponent.BodyTube;
import info.openrocket.core.rocketcomponent.Bulkhead;
import info.openrocket.core.rocketcomponent.CenteringRing;
import info.openrocket.core.rocketcomponent.ComponentAssembly;
import info.openrocket.core.rocketcomponent.EngineBlock;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.InnerTube;
import info.openrocket.core.rocketcomponent.MassComponent;
import info.openrocket.core.rocketcomponent.NoseCone;
import info.openrocket.core.rocketcomponent.Parachute;
import info.openrocket.core.rocketcomponent.RecoveryDevice;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.rocketcomponent.Transition;
import info.openrocket.core.rocketcomponent.position.AxialMethod;
import info.openrocket.core.startup.Application;
import info.openrocket.core.unit.CaliberUnit;

/**
 * The recovery and ballast helpers' sums (Tools > Recovery and Tools > Ballast in the browser version): the
 * size of parachute for a descent rate, the black powder for an ejection charge and how many shear
 * pins it breaks, and the nose weight for a stability margin; each from the design as OpenRocket
 * sees it.
 */
public final class Recovery {
	public static final double G = 9.80665;

	private Recovery() {
	}

	/** Air density (kg/m³) at an altitude above sea level (m), in OpenRocket's standard atmosphere. */
	public static double airDensity(double altitude) {
		return new ExtendedISAModel().getConditions(altitude).getDensity();
	}

	// ------------------------------------------------------------------ parachute

	/** The steady descent rate (m/s) of mass m (kg) under drag area cdA (drag coefficient times area, m²). */
	public static double descentRate(double m, double cdA, double rho) {
		return Math.sqrt(2 * m * G / (rho * cdA));
	}

	/** The drag area (m²) for descent rate v (m/s) with mass m (kg). */
	public static double dragAreaFor(double m, double v, double rho) {
		return 2 * m * G / (rho * v * v);
	}

	/** A parachute's diameter (m) for drag area cdA with drag coefficient cd (its area π D²/4, as OpenRocket has it). */
	public static double diameterFor(double cdA, double cd) {
		return cdA > 0 && cd > 0 ? Math.sqrt(4 * cdA / (Math.PI * cd)) : Double.NaN;
	}

	/**
	 * A parachute in its design: what it brings down (its stage after burnout, motor cases and all,
	 * the parachute itself at whatever size) and the other recovery devices of that stage, open with
	 * it at landing.
	 */
	public static final class ParachuteCase {
		public final Parachute chute;
		/** The other recovery devices in its stage: their drag areas (m²) and names. */
		public final double othersDragArea;
		public final List<String> others = new ArrayList<>();
		private final Rocket copy;
		private final Parachute copyChute;
		private final FlightConfiguration stageOnly;

		ParachuteCase(Parachute chute, FlightConfiguration config) {
			this.chute = chute;
			this.copy = chute.getRocket().copyWithOriginalID();
			this.copyChute = (Parachute) copy.findComponent(chute.getID());
			this.stageOnly = copy.getFlightConfiguration(config.getFlightConfigurationID()).clone();
			stageOnly.setOnlyStage(chute.getStageNumber());
			double area = 0;
			for (RocketComponent c : chute.getStage()) {
				if (c instanceof RecoveryDevice && c != chute) {
					area += ((RecoveryDevice) c).getCD() * ((RecoveryDevice) c).getArea();
					others.add(c.getName());
				}
			}
			this.othersDragArea = area;
		}

		/** The mass it brings down (kg) with the parachute at this diameter (m). */
		public double mass(double diameter) {
			copyChute.setDiameter(diameter);
			return MassCalculator.calculateBurnout(stageOnly).getMass();
		}

		/** The descent rate (m/s) at this diameter, with drag coefficient cd; mass NaN: the design's. */
		public double rate(double diameter, double cd, double rho, boolean withOthers, double mass) {
			double m = Double.isNaN(mass) ? mass(diameter) : mass;
			double area = cd * Math.PI * diameter * diameter / 4 + (withOthers ? othersDragArea : 0);
			return descentRate(m, area, rho);
		}

		/**
		 * The diameter (m) for descent rate v (m/s): NaN if the other devices alone bring it down
		 * slower. Mass NaN: the design's, which grows with the canopy (a few rounds settle it).
		 */
		public double diameterFor(double v, double cd, double rho, boolean withOthers, double mass) {
			double d = chute.getDiameter() > 0 ? chute.getDiameter() : 0.3;
			for (int round = 0; round < 8; round++) {
				double m = Double.isNaN(mass) ? mass(d) : mass;
				double area = dragAreaFor(m, v, rho) - (withOthers ? othersDragArea : 0);
				double next = area > 0 ? Recovery.diameterFor(area, cd) : Double.NaN;
				if (Double.isNaN(next)) {
					return Double.NaN;
				}
				boolean settled = Math.abs(next - d) < 1e-6;
				d = next;
				if (settled || !Double.isNaN(mass)) {
					break;
				}
			}
			return d;
		}
	}

	public static ParachuteCase parachute(Parachute chute, FlightConfiguration config) {
		return new ParachuteCase(chute, config);
	}

	/** The parachutes in a rocket. */
	public static List<Parachute> parachutes(Rocket rocket) {
		List<Parachute> out = new ArrayList<>();
		for (RocketComponent c : rocket) {
			if (c instanceof Parachute) {
				out.add((Parachute) c);
			}
		}
		return out;
	}

	// ------------------------------------------------------------------ ejection charge

	/**
	 * Black powder's combustion gas (FFFFg), as rocketry's ejection charge sums take it: its gas
	 * constant (22.16 ft·lbf/(lbm·°R), here in J/(kg·K)) and temperature (3307 °R, in K).
	 */
	public static final double BP_GAS_CONSTANT = 22.16 * 1.3558179483314004 / (0.45359237 * 5.0 / 9.0);
	public static final double BP_TEMPERATURE = 3307 * 5.0 / 9.0;

	/**
	 * The black powder (kg) to pressurise a volume (m³) to a pressure above the outside air (Pa), by
	 * the ideal gas law as every online charge calculator works it out. Measured, it is neither: in an
	 * empty sealed tube the peak is about 4.4 times this (the charge's heat also heats the air), and a
	 * parachute packed in the tube soaks up most of that heat. {@link #charge} allows for the packing.
	 */
	public static double blackPowder(double pressure, double volume) {
		return pressure * volume / (BP_GAS_CONSTANT * BP_TEMPERATURE);
	}

	/**
	 * How much of the bay the parachute and its shock cord fill, and what that does to the charge:
	 * the factor on {@link #blackPowder}. They fit T. Fetter's ground tests ("Using Black Powder for
	 * Parachute Deployment", NARCON 2025: 2.15 x 9 and 3 x 15 inch bays, two 2-56 pins) with this
	 * tool's pin strengths and margin: the charge comes out at least what first separated them and at
	 * most twice what ejected them hard. His tests found a tube bursts at 1.5-2 times that much.
	 * Packed full they needed about twice the ideal gas law's amount for this margin (rockets that
	 * failed to deploy on that amount flew 13 times on twice it); filling the half by the charge,
	 * about that amount; a quarter full, the far half or behind a piston, less.
	 */
	public enum Packing {
		FULL("Fills the bay", 2), HALF("Fills half, next to the charge", 1), SMALL("Small, at the far end or behind a piston", 0.75);

		public final String label;
		public final double factor;

		Packing(String label, double factor) {
			this.label = label;
			this.factor = factor;
		}
	}

	/** The black powder (kg) for a pressure (Pa) on the bulkhead of a bay (m³) packed like this. */
	public static double charge(double pressure, double volume, Packing packing) {
		return blackPowder(pressure, volume) * packing.factor;
	}

	/**
	 * Shear pins: their usual sizes and strength each (N), from nylon 6/6's shear strength (9,600 psi)
	 * over the thread's root area, as the other calculators take it. Damerau's lab tests found a
	 * little less (2-56: 21-25 lbf, 4-40: 38-41 lbf a pin); makes and batches vary.
	 */
	public enum ShearPin {
		NYLON_2_56("2-56 nylon", 31), NYLON_4_40("4-40 nylon", 50);

		public final String label;
		/** Pounds-force, as they are usually quoted, and newtons. */
		public final double lbf, newtons;

		ShearPin(String label, double lbf) {
			this.label = label;
			this.lbf = lbf;
			this.newtons = lbf * 4.4482216152605;
		}
	}

	/** How much more the charge's push should be than the pins' strength together. */
	public static final double PIN_MARGIN = 2;

	/** The pressure (Pa) whose push on a bulkhead of this diameter (m) is the margin times n pins' strength (N each). */
	public static double pressureForPins(int n, double strength, double diameter) {
		return PIN_MARGIN * n * strength / (Math.PI * diameter * diameter / 4);
	}

	/** How many pins (N each) a pressure (Pa) on a bulkhead of this diameter breaks with the margin. */
	public static int pinsBroken(double pressure, double strength, double diameter) {
		return (int) Math.floor(pressure * Math.PI * diameter * diameter / 4 / (PIN_MARGIN * strength) + 1e-9);
	}

	/**
	 * An ejection bay: a body tube's inside, between whatever closes it off around a recovery device
	 * (bulkheads, centering rings, engine blocks, inner tubes, the shoulder of a nose cone or
	 * transition fitting into it). Lengths in m.
	 */
	public static final class Bay {
		public final BodyTube tube;
		public final double diameter, from, to;

		Bay(BodyTube tube, double diameter, double from, double to) {
			this.tube = tube;
			this.diameter = diameter;
			this.from = from;
			this.to = to;
		}

		public double length() {
			return to - from;
		}

		public double volume() {
			return Math.PI * diameter * diameter / 4 * length();
		}
	}

	/** The body tubes in a rocket. */
	public static List<BodyTube> tubes(Rocket rocket) {
		List<BodyTube> out = new ArrayList<>();
		for (RocketComponent c : rocket) {
			if (c instanceof BodyTube) {
				out.add((BodyTube) c);
			}
		}
		return out;
	}

	/** The body tube a recovery device is in (null if none). */
	public static BodyTube tubeOf(RocketComponent device) {
		for (RocketComponent c = device.getParent(); c != null; c = c.getParent()) {
			if (c instanceof BodyTube) {
				return (BodyTube) c;
			}
		}
		return null;
	}

	/**
	 * The bay of a tube around a point `at` (m from the tube's front; NaN: its middle): what closes
	 * it off may be in the tube or reach into it from the parts beside it, such as the bulkhead in a
	 * nose cone's coupler.
	 */
	public static Bay bay(BodyTube tube, double at) {
		double length = tube.getLength();
		double point = Double.isNaN(at) ? length / 2 : at;
		double x0 = front(tube);
		double from = 0, to = length;
		RocketComponent parent = tube.getParent();
		List<RocketComponent> near = new ArrayList<>();
		if (parent == null) {
			separators(tube, near);
		} else {
			for (RocketComponent sibling : parent.getChildren()) {
				separators(sibling, near);
			}
		}
		for (RocketComponent c : near) {
			double top = front(c) - x0, end = top + c.getLength();
			if (end <= 1e-9 || top >= length - 1e-9) {
				continue; // not in this tube
			}
			if (end <= point) {
				from = Math.max(from, end);
			} else if (top >= point) {
				to = Math.min(to, top);
			}
		}
		// Shoulders fitting into the tube's ends.
		if (parent != null) {
			int i = parent.getChildPosition(tube);
			if (i > 0 && parent.getChild(i - 1) instanceof Transition) {
				from = Math.max(from, ((Transition) parent.getChild(i - 1)).getAftShoulderLength());
			}
			if (i + 1 < parent.getChildCount() && parent.getChild(i + 1) instanceof Transition) {
				to = Math.min(to, length - ((Transition) parent.getChild(i + 1)).getForeShoulderLength());
			}
		}
		return new Bay(tube, 2 * tube.getInnerRadius(), from, Math.max(from, to));
	}

	/** What closes off a bay, in c and inside it; not in pods or side boosters. */
	private static void separators(RocketComponent c, List<RocketComponent> out) {
		if (c instanceof Bulkhead || c instanceof CenteringRing || c instanceof EngineBlock || c instanceof InnerTube) {
			out.add(c);
		}
		for (RocketComponent child : c.getChildren()) {
			if (!(child instanceof ComponentAssembly)) {
				separators(child, out);
			}
		}
	}

	/** The bay a recovery device is in: in its tube, around it (null if it is in no tube). */
	public static Bay bayOf(RocketComponent device) {
		BodyTube tube = tubeOf(device);
		if (tube == null) {
			return null;
		}
		return bay(tube, front(device) - front(tube) + device.getLength() / 2);
	}

	// ------------------------------------------------------------------ nose weight

	/** Stability as OpenRocket's design view has it, for one flight configuration. Lengths in m from the nose tip. */
	public static final class Stability {
		public final FlightConfiguration config;
		public final double mass, cg, cp, caliber;

		Stability(FlightConfiguration config, double mass, double cg, double cp, double caliber) {
			this.config = config;
			this.mass = mass;
			this.cg = cg;
			this.cp = cp;
			this.caliber = caliber;
		}

		/** In calibers. */
		public double margin() {
			return (cp - cg) / caliber;
		}

	}

	/** The design view's stability for a flight configuration: worst centre of pressure at its Mach number, centre of gravity at launch. */
	public static Stability stability(FlightConfiguration config) {
		FlightConditions conditions = new FlightConditions(config);
		conditions.setMach(Application.getPreferences().getDefaultMach());
		conditions.setAOA(0);
		conditions.setRollRate(0);
		double cp = new BarrowmanCalculator().getWorstCP(config, conditions, new WarningSet()).x;
		RigidBody launch = MassCalculator.calculateLaunch(config);
		return new Stability(config, launch.getMass(), launch.getCM().x, cp, CaliberUnit.calculateCaliber(config));
	}

	/** The name the nose weight these helpers add goes by. */
	public static final String NOSE_WEIGHT = "Nose weight";

	/** Where nose weight goes: the nose cone, else the rocket's first component. */
	public static RocketComponent noseOf(Rocket rocket) {
		for (RocketComponent c : rocket) {
			if (c instanceof NoseCone) {
				return c;
			}
		}
		AxialStage first = rocket.getChildCount() > 0 ? (AxialStage) rocket.getChild(0) : null;
		return first != null && first.getChildCount() > 0 ? first.getChild(0) : null;
	}

	/** The nose weight these helpers added to `nose` before, if any. */
	public static MassComponent noseWeightIn(RocketComponent nose) {
		for (RocketComponent c : nose.getChildren()) {
			if (c instanceof MassComponent && NOSE_WEIGHT.equals(c.getName())) {
				return (MassComponent) c;
			}
		}
		return null;
	}

	/** The stability of each flight configuration with motors, as the design is. */
	public static List<Stability> stabilities(Rocket rocket) {
		List<Stability> out = new ArrayList<>();
		for (FlightConfiguration config : rocket.getFlightConfigurations()) {
			if (config.hasMotors()) {
				out.add(stability(config));
			}
		}
		return out;
	}

	/**
	 * How a flight configuration's stability answers weight put at one point: its stability without
	 * the nose weight these helpers added before (so that the weight worked out is all of it, not
	 * more of it), and its centre of gravity with w kg there, cg(w) = (cg + b w) / (1 + d w).
	 * That form holds whatever masses are overridden: with none, b = x / M and d = 1 / M; a part
	 * whose mass is overridden along with what is in it keeps its mass and moves its centre of
	 * gravity; one whose centre of gravity is overridden does not move it at all.
	 */
	public static final class Response {
		public final Stability without;
		private final double b, d;

		Response(Stability without, double w1, double cg1, double w2, double cg2) {
			this.without = without;
			double a = without.cg;
			if (Math.abs(cg1 - a) < 1e-12 && Math.abs(cg2 - a) < 1e-12) {
				b = d = 0; // weight there changes nothing
			} else {
				d = ((cg1 - a) / w1 - (cg2 - a) / w2) / (cg2 - cg1);
				b = (cg1 - a) / w1 + d * cg1;
			}
		}

		/** True if weight there does not move the centre of gravity. */
		public boolean noEffect() {
			return b == 0 && d == 0;
		}

		/** The centre of gravity with w kg of weight there, m from the nose tip. */
		public double cg(double w) {
			return (without.cg + b * w) / (1 + d * w);
		}

		/**
		 * The weight (kg) there for a margin of `target` calibers: 0 if it has that without any, NaN
		 * if no weight there gives it.
		 */
		public double weightFor(double target) {
			double wanted = without.cp - target * without.caliber;
			if (without.cg <= wanted) {
				return 0;
			}
			double w = (without.cg - wanted) / (wanted * d - b);
			return w > 0 && Double.isFinite(w) ? w : Double.NaN;
		}
	}

	/**
	 * How each flight configuration with motors answers nose weight centred at x (m from the nose
	 * tip), as OpenRocket's mass calculation has it, worked out on a copy of the design.
	 */
	public static List<Response> responses(Rocket rocket, double x) {
		Rocket copy = rocket.copyWithOriginalID();
		RocketComponent nose = noseOf(copy);
		List<Response> out = new ArrayList<>();
		if (nose == null) {
			return out;
		}
		setNoseWeight(nose, 1e-3, x);
		MassComponent weight = noseWeightIn(nose);
		weight.setMassOverridden(false);
		weight.setCGOverridden(false);
		for (FlightConfiguration config : copy.getFlightConfigurations()) {
			if (!config.hasMotors()) {
				continue;
			}
			weight.setComponentMass(0);
			Stability without = stability(config);
			double w1 = 0.1 * without.mass, w2 = without.mass;
			weight.setComponentMass(w1);
			double cg1 = MassCalculator.calculateLaunch(config).getCM().x;
			weight.setComponentMass(w2);
			double cg2 = MassCalculator.calculateLaunch(config).getCM().x;
			out.add(new Response(without, w1, cg1, w2, cg2));
		}
		return out;
	}

	/**
	 * The part whose overridden mass covers what is in `nose` (the nose itself or a part around it),
	 * so that weight there moves the centre of gravity without adding mass; null if none.
	 */
	public static RocketComponent massOverriddenAround(RocketComponent nose) {
		return nose.isMassOverridden() && nose.isSubcomponentsOverriddenMass() ? nose : nose.getMassOverriddenBy();
	}

	/** Where a component's front is, m from the nose tip. */
	public static double front(RocketComponent c) {
		return c.getComponentLocations()[0].x;
	}

	/**
	 * Gives `nose` a nose weight of this mass (kg) centred at x (m from the nose tip), adding the
	 * component or changing the one there; none (0 or less) removes it.
	 */
	public static void setNoseWeight(RocketComponent nose, double mass, double x) {
		MassComponent weight = noseWeightIn(nose);
		if (!(mass > 0)) {
			if (weight != null) {
				nose.removeChild(weight);
			}
			return;
		}
		double length = Math.max(0.005, Math.min(0.03, nose.getLength() / 6));
		boolean added = weight == null;
		if (added) {
			weight = new MassComponent();
			weight.setName(NOSE_WEIGHT);
		}
		weight.setLength(length);
		double inside = nose instanceof Transition ? ((Transition) nose).getRadius(Math.max(0, x - front(nose))) : 0;
		weight.setRadius(inside > 0 ? inside * 0.8 : Math.max(0.002, weight.getRadius()));
		weight.setComponentMass(mass);
		weight.setAxialMethod(AxialMethod.TOP);
		weight.setAxialOffset(x - front(nose) - length / 2);
		if (added) {
			nose.addChild(weight);
		}
	}
}
