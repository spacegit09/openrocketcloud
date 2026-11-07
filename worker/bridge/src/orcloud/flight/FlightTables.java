package orcloud.flight;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeSet;

import info.openrocket.core.aerodynamics.AerodynamicForces;
import info.openrocket.core.aerodynamics.BarrowmanCalculator;
import info.openrocket.core.aerodynamics.FlightConditions;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.aerodynamics.barrowman.FinSetCalc;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.models.atmosphere.AtmosphericConditions;
import info.openrocket.core.models.atmosphere.AtmosphericModel;
import info.openrocket.core.motor.IgnitionEvent;
import info.openrocket.core.motor.Motor;
import info.openrocket.core.motor.MotorConfiguration;
import info.openrocket.core.motor.ThrustCurveMotor;
import info.openrocket.core.rocketcomponent.DeploymentConfiguration;
import info.openrocket.core.rocketcomponent.FinSet;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.InstanceContext;
import info.openrocket.core.rocketcomponent.RecoveryDevice;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.rocketcomponent.SymmetricComponent;
import info.openrocket.core.simulation.FlightData;
import info.openrocket.core.simulation.FlightDataBranch;
import info.openrocket.core.simulation.FlightDataType;
import info.openrocket.core.simulation.FlightEvent;
import info.openrocket.core.simulation.SimulationOptions;
import info.openrocket.core.simulation.listeners.SimulationListener;
import info.openrocket.core.util.Coordinate;

/**
 * What the launch planner's flight engine (web/src/flight/engine.js) needs to fly a rocket the way
 * OpenRocket does, computed by OpenRocket for one simulation's flight configuration: aerodynamic
 * coefficients over Mach number, angle of attack and Reynolds number, the pitch damping factor,
 * thrust from the motors' curves, mass and inertia over time (from one OpenRocket run of the
 * simulation), recovery devices and launch settings, and OpenRocket's own result. As JSON.
 *
 * The coefficients come from OpenRocket's BarrowmanCalculator exactly as its RK4 simulation asks
 * for them: normal force and centre of pressure at zero rates (the moment about the nose is their
 * product), and drag at zero angle of attack (OpenRocket's drag does not depend on it; the axial
 * part is scaled by a fixed curve over the angle, also tabulated).
 */
public final class FlightTables {
	public static final int VERSION = 1;
	static final double[] MACH = { 0.01, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.2, 1.3,
			1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0 };
	static final double[] ALPHA = { 0, 1, 2, 3, 4, 6, 8, 10, 13, 17, 20, 25, 30, 40, 50, 60, 70, 80, 90 }; // degrees
	static final double[] LOG_RE = { 4, 5, 5.5, 6, 6.5, 7, 7.5, 8, 9 };
	private static final double T = 288.15; // the air temperature the tables are computed at
	private static final double R = AtmosphericConditions.R;

	private FlightTables() {
	}

	/** The tables for `sim` (run once here, on a copy, with its own options and `listeners`). */
	public static String compute(Simulation sim, SimulationListener... listeners) throws Exception {
		FlightConfiguration config = sim.getActiveConfiguration();
		Json j = new Json();
		j.open();
		j.num("version", VERSION);
		j.str("rocket", sim.getRocket().getName());
		j.str("simulation", sim.getName());
		j.str("configuration", config.getName());

		String unsupported = unsupported(config);
		j.str("unsupported", unsupported);
		// Simulation extensions and scripts change a flight in ways the engine does not follow.
		StringBuilder ext = new StringBuilder();
		for (info.openrocket.core.simulation.extension.SimulationExtension x : sim.getSimulationExtensions()) {
			ext.append(ext.length() > 0 ? ", " : "").append(x.getName());
		}
		j.str("extensions", ext.length() > 0 ? ext.toString() : null);
		// Fin sets of one or two fins push sideways depending on how the rocket is rolled, which the
		// engine does not follow (it uses the forces at one roll angle).
		String uneven = null;
		for (RocketComponent c : config.getActiveComponents()) {
			if (c instanceof FinSet && ((FinSet) c).getFinCount() < 3) {
				uneven = "Fin sets with fewer than three fins (" + c.getName() + ") make results differ from OpenRocket's.";
			}
		}
		j.str("approximate", uneven);

		BarrowmanCalculator calc = new BarrowmanCalculator();
		FlightConditions fc = new FlightConditions(config);
		double refArea = fc.getRefArea();
		double refLength = fc.getRefLength();
		double aeroLength = config.getLengthAerodynamic();
		j.key("ref").open().num("area", refArea).num("length", refLength).num("aeroLength", aeroLength).close();

		// Normal force and centre of pressure over Mach number and angle of attack.
		double[][] cn = new double[MACH.length][ALPHA.length];
		double[][] cp = new double[MACH.length][ALPHA.length];
		for (int m = 0; m < MACH.length; m++) {
			for (int a = 0; a < ALPHA.length; a++) {
				AerodynamicForces f = forces(calc, config, MACH[m], Math.toRadians(ALPHA[a]), 101325);
				cn[m][a] = f.getCN();
				cp[m][a] = f.getCP().x;
			}
		}
		// Drag over Mach number and Reynolds number (OpenRocket's: velocity times aerodynamic length
		// over kinematic viscosity), at zero angle of attack.
		double[][] cd = new double[MACH.length][LOG_RE.length];
		for (int m = 0; m < MACH.length; m++) {
			double v = MACH[m] * (165.77 + 0.606 * T);
			for (int r = 0; r < LOG_RE.length; r++) {
				double mu = 3.7291e-06 + 4.9944e-08 * T;
				double pressure = Math.pow(10, LOG_RE[r]) * mu * R * T / (v * aeroLength);
				cd[m][r] = forces(calc, config, MACH[m], 0, pressure).getCD();
			}
		}
		// The axial part of the drag over the angle of attack, as a factor (0 to 180 degrees).
		double[] axial = new double[181];
		for (int a = 0; a <= 180; a++) {
			AerodynamicForces f = forces(calc, config, 0.3, Math.toRadians(a), 101325);
			axial[a] = f.getCD() == 0 ? (a < 90 ? 1 : -1) : f.getCDaxial() / f.getCD();
		}
		j.key("aero").open().nums("mach", MACH).nums("alpha", ALPHA).nums("logRe", LOG_RE).grid("cn", cn).grid("cp", cp)
				.grid("cd", cd).nums("axial", axial).close();
		j.num("damping", 3 * dampingMultiplier(config, refArea, refLength));
		j.num("tumbleCD", tumbleCD(config, refArea));

		// Thrust from the motors' own curves (all motors, clusters counted, by ignition time).
		List<double[]> motors = new ArrayList<>(); // ignition, motor index
		List<Motor> motorList = new ArrayList<>();
		List<Integer> counts = new ArrayList<>();
		TreeSet<Double> times = new TreeSet<>();
		double burnout = 0;
		List<Double> ejections = new ArrayList<>();
		for (MotorConfiguration mc : config.getActiveMotors()) {
			Motor motor = mc.getMotor();
			if (motor == null) {
				continue;
			}
			IgnitionEvent ev = mc.getIgnitionEvent();
			if (ev != IgnitionEvent.AUTOMATIC && ev != IgnitionEvent.LAUNCH) {
				continue; // flagged as unsupported above
			}
			double ign = mc.getIgnitionDelay();
			double[] tp = ((ThrustCurveMotor) motor).getTimePoints();
			for (double t : tp) {
				times.add(ign + t);
			}
			double end = ign + tp[tp.length - 1];
			for (double t = ign; t < end; t += 0.005) {
				times.add(t);
			}
			burnout = Math.max(burnout, end);
			if (!Double.isNaN(mc.getEjectionDelay()) && mc.getEjectionDelay() != Motor.PLUGGED_DELAY) {
				ejections.add(end + mc.getEjectionDelay());
			}
			motors.add(new double[] { ign });
			motorList.add(motor);
			counts.add(mc.getMotorCount());
		}
		double[] thrustT = new double[times.size()];
		double[] thrustF = new double[times.size()];
		int k = 0;
		for (double t : times) {
			double f = 0;
			for (int i = 0; i < motorList.size(); i++) {
				double mt = t - motors.get(i)[0];
				if (mt >= 0) {
					f += counts.get(i) * motorList.get(i).getThrust(mt);
				}
			}
			thrustT[k] = t;
			thrustF[k++] = f;
		}
		j.key("thrust").open().nums("time", thrustT).nums("force", thrustF).close();
		j.num("burnout", burnout);
		j.nums("ejections", ejections.stream().mapToDouble(Double::doubleValue).toArray());

		// Recovery devices.
		j.key("recovery").arr();
		for (RocketComponent c : config.getActiveComponents()) {
			if (!(c instanceof RecoveryDevice)) {
				continue;
			}
			RecoveryDevice rd = (RecoveryDevice) c;
			DeploymentConfiguration dc = rd.getDeploymentConfigurations().get(config.getFlightConfigurationID());
			j.open().str("name", rd.getName()).num("cd", rd.getCD()).num("area", rd.getArea())
					.num("count", config.getActiveInstances().count(rd)).str("event", dc.getDeployEvent().name())
					.num("altitude", dc.getDeployAltitude()).num("delay", dc.getDeployDelay()).close();
		}
		j.end();

		SimulationOptions o = sim.getOptions();
		j.key("launch").open().num("rodLength", o.getLaunchRodLength()).num("rodAngle", o.getLaunchRodAngle())
				.num("rodDirection", o.getLaunchRodDirection()).num("altitude", o.getLaunchAltitude())
				.num("latitude", o.getLaunchLatitude()).num("longitude", o.getLaunchLongitude())
				.num("timeStep", o.getTimeStep()).str("geodetic", o.getGeodeticComputation().name()).close();

		// One OpenRocket run: mass, centre of gravity and inertia over time, and OpenRocket's result.
		Simulation run = sim.copy();
		run.simulate(listeners);
		FlightData data = run.getSimulatedData();
		FlightDataBranch b = data.getBranch(0);
		List<Double> time = b.get(FlightDataType.TYPE_TIME);
		List<Double> mass = b.get(FlightDataType.TYPE_MASS);
		List<Double> cg = b.get(FlightDataType.TYPE_CG_LOCATION);
		List<Double> il = b.get(FlightDataType.TYPE_LONGITUDINAL_INERTIA);
		List<Double> ir = b.get(FlightDataType.TYPE_ROTATIONAL_INERTIA);
		List<double[]> rows = new ArrayList<>();
		double lastT = -1;
		for (int i = 0; i < time.size(); i++) {
			double t = time.get(i);
			boolean changing = t <= burnout + 0.1;
			if (Double.isNaN(mass.get(i)) || Double.isNaN(il.get(i)) || (!changing && lastT > burnout + 0.1) || t <= lastT) {
				continue;
			}
			rows.add(new double[] { t, mass.get(i), cg.get(i), il.get(i), ir.get(i) });
			lastT = t;
		}
		j.key("mass").open().nums("time", column(rows, 0)).nums("mass", column(rows, 1)).nums("cg", column(rows, 2))
				.nums("iLong", column(rows, 3)).nums("iRot", column(rows, 4)).close();

		j.key("openrocket");
		results(j, data);

		// The air the run flew in (for checking the engine against it): every 100 m from the ground.
		AtmosphericModel air = o.toSimulationConditions().getAtmosphericModel();
		int levels = (int) Math.ceil((data.getMaxAltitude() + 500) / 100) + 1;
		double[][] atmo = new double[levels][];
		for (int i = 0; i < levels; i++) {
			AtmosphericConditions a = air.getConditions(o.getLaunchAltitude() + i * 100);
			atmo[i] = new double[] { i * 100, a.getTemperature(), a.getPressure() };
		}
		j.grid("atmosphere", atmo);
		j.close();
		return j.toString();
	}

	/** OpenRocket's result for `sim` (run on a copy, with `listeners`), as JSON. */
	public static String run(Simulation sim, SimulationListener... listeners) throws Exception {
		Simulation run = sim.copy();
		run.simulate(listeners);
		Json j = new Json();
		results(j, run.getSimulatedData());
		return j.toString();
	}

	private static void results(Json j, FlightData data) {
		FlightDataBranch b = data.getBranch(0);
		j.open().num("apogee", data.getMaxAltitude()).num("maxVelocity", data.getMaxVelocity())
				.num("maxMach", data.getMaxMachNumber()).num("timeToApogee", data.getTimeToApogee())
				.num("flightTime", data.getFlightTime()).num("groundHitVelocity", data.getGroundHitVelocity())
				.num("landingEast", b.getLast(FlightDataType.TYPE_POSITION_X))
				.num("landingNorth", b.getLast(FlightDataType.TYPE_POSITION_Y));
		j.key("events").arr();
		for (FlightEvent e : b.getEvents()) {
			j.open().str("type", e.getType().name()).num("time", e.getTime()).close();
		}
		j.end();
		j.close();
	}

	private static AerodynamicForces forces(BarrowmanCalculator calc, FlightConfiguration config, double mach, double aoa,
			double pressure) {
		FlightConditions fc = new FlightConditions(config);
		fc.setAtmosphericConditions(new AtmosphericConditions(T, pressure));
		fc.setMach(mach);
		fc.setAOA(aoa);
		fc.setTheta(0);
		fc.setRollRate(0);
		fc.setPitchRate(0);
		fc.setYawRate(0);
		return calc.getAerodynamicForces(config, fc, new WarningSet());
	}

	/**
	 * OpenRocket's pitch damping multiplier (BarrowmanCalculator.getDampingMultiplier): its
	 * simulation never sets a pitch centre, so it is taken about the nose tip and is the same for
	 * the whole flight.
	 */
	static double dampingMultiplier(FlightConfiguration config, double refArea, double refLength) {
		double area = 0;
		double length = 0;
		for (RocketComponent c : config.getActiveComponents()) {
			if (c instanceof SymmetricComponent) {
				area += ((SymmetricComponent) c).getComponentPlanformArea();
				length += c.getLength();
			}
		}
		double diameter = length > 0 ? area / length : 0;
		double mul = 0.275 * diameter / (refArea * refLength) * Math.pow(length, 4);
		for (RocketComponent c : config.getActiveComponents()) {
			if (c instanceof FinSet) {
				FinSet f = (FinSet) c;
				double x = f.toAbsolute(new Coordinate(new FinSetCalc(f).getMidchordPos()))[0].x;
				mul += 0.6 * Math.min(f.getFinCount(), 4) * f.getPlanformArea() * Math.pow(Math.abs(x), 3) / (refArea * refLength);
			}
		}
		return mul;
	}

	/** OpenRocket's drag coefficient for a tumbling rocket (BasicTumbleStepper). */
	static double tumbleCD(FlightConfiguration config, double refArea) {
		final double[] finEff = { 0.0, 0.5, 1.0, 1.41, 1.81, 1.73, 1.90, 1.85 };
		double aFins = 0;
		double aBt = 0;
		for (Map.Entry<RocketComponent, ArrayList<InstanceContext>> e : config.getActiveInstances().entrySet()) {
			RocketComponent c = e.getKey();
			if (!c.isAerodynamic()) {
				continue;
			}
			for (int i = 0; i < e.getValue().size(); i++) {
				if (c instanceof FinSet) {
					FinSet f = (FinSet) c;
					aFins += f.getPlanformArea() * finEff[Math.min(f.getFinCount(), finEff.length - 1)] / f.getFinCount();
				} else if (c instanceof SymmetricComponent) {
					aBt += ((SymmetricComponent) c).getComponentPlanformArea();
				}
			}
		}
		return (1.42 * aFins + 0.56 * aBt) / refArea;
	}

	/** Why the engine cannot fly this configuration yet, or null. */
	static String unsupported(FlightConfiguration config) {
		if (config.getActiveStageCount() > 1) {
			return "Rockets with more than one stage, or with boosters, are not supported yet.";
		}
		boolean any = false;
		for (MotorConfiguration mc : config.getActiveMotors()) {
			if (mc.getMotor() == null) {
				continue;
			}
			any = true;
			IgnitionEvent ev = mc.getIgnitionEvent();
			if (ev != IgnitionEvent.AUTOMATIC && ev != IgnitionEvent.LAUNCH) {
				return "Motors that ignite in flight (air starts) are not supported yet.";
			}
		}
		return any ? null : "This flight configuration has no motor.";
	}

	private static double[] column(List<double[]> rows, int c) {
		double[] out = new double[rows.size()];
		for (int i = 0; i < out.length; i++) {
			out[i] = rows.get(i)[c];
		}
		return out;
	}

	/** A small JSON writer for numbers, strings, arrays and objects. */
	static final class Json {
		private final StringBuilder sb = new StringBuilder();
		private boolean first = true;

		private void sep() {
			if (!first) {
				sb.append(',');
			}
			first = false;
		}

		Json key(String k) {
			sep();
			sb.append('"').append(k).append("\":");
			first = true;
			return this;
		}

		Json open() {
			sep();
			sb.append('{');
			first = true;
			return this;
		}

		Json close() {
			sb.append('}');
			first = false;
			return this;
		}

		Json arr() {
			sep();
			sb.append('[');
			first = true;
			return this;
		}

		Json end() {
			sb.append(']');
			first = false;
			return this;
		}

		Json str(String k, String v) {
			key(k);
			if (v == null) {
				sb.append("null");
			} else {
				sb.append('"').append(v.replace("\\", "\\\\").replace("\"", "\\\"").replaceAll("[\\x00-\\x1f]", " ")).append('"');
			}
			first = false;
			return this;
		}

		Json num(String k, double v) {
			key(k);
			sb.append(fmt(v));
			first = false;
			return this;
		}

		Json nums(String k, double[] v) {
			key(k);
			sb.append('[');
			for (int i = 0; i < v.length; i++) {
				sb.append(i == 0 ? "" : ",").append(fmt(v[i]));
			}
			sb.append(']');
			first = false;
			return this;
		}

		Json grid(String k, double[][] v) {
			key(k);
			sb.append('[');
			for (int i = 0; i < v.length; i++) {
				sb.append(i == 0 ? "[" : ",[");
				for (int c = 0; c < v[i].length; c++) {
					sb.append(c == 0 ? "" : ",").append(fmt(v[i][c]));
				}
				sb.append(']');
			}
			sb.append(']');
			first = false;
			return this;
		}

		private static String fmt(double v) {
			if (Double.isNaN(v) || Double.isInfinite(v)) {
				return "null";
			}
			if (v == Math.rint(v) && Math.abs(v) < 1e15) {
				return Long.toString((long) v);
			}
			return String.format(Locale.ROOT, "%.9g", v).replaceAll("(\\.\\d*?)0+(e|$)", "$1$2").replace(".e", "e")
					.replaceAll("\\.$", "");
		}

		@Override
		public String toString() {
			return sb.toString();
		}
	}
}
