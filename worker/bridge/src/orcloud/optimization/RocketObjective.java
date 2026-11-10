package orcloud.optimization;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import info.openrocket.core.aerodynamics.BarrowmanCalculator;
import info.openrocket.core.aerodynamics.FlightConditions;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.masscalc.MassCalculator;
import info.openrocket.core.optimization.general.OptimizationException;
import info.openrocket.core.optimization.rocketoptimization.OptimizableParameter;
import info.openrocket.core.optimization.rocketoptimization.OptimizationGoal;
import info.openrocket.core.optimization.rocketoptimization.SimulationModifier;
import info.openrocket.core.optimization.rocketoptimization.parameters.SimulationBasedParameter;
import info.openrocket.core.rocketcomponent.FinSet;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.rocketcomponent.SymmetricComponent;
import info.openrocket.core.simulation.FlightData;
import info.openrocket.core.simulation.FlightDataBranch;
import info.openrocket.core.simulation.FlightDataType;
import info.openrocket.core.simulation.RK4SimulationStepper;
import info.openrocket.core.simulation.SimulationOptions;
import info.openrocket.core.simulation.SimulationStatus;
import info.openrocket.core.simulation.exception.SimulationCalculationException;
import info.openrocket.core.simulation.exception.SimulationCancelledException;
import info.openrocket.core.simulation.exception.SimulationException;
import info.openrocket.core.simulation.extension.SimulationExtension;
import info.openrocket.core.simulation.listeners.AbstractSimulationListener;
import info.openrocket.core.simulation.listeners.SimulationListener;
import info.openrocket.core.simulation.listeners.system.ApogeeEndListener;
import info.openrocket.core.startup.Application;
import info.openrocket.core.unit.UnitGroup;
import info.openrocket.core.unit.Value;
import info.openrocket.core.util.Coordinate;
import info.openrocket.core.util.MathUtil;
import orcloud.fins.FinFlutter;

/**
 * What the rocket optimiser makes lowest: OpenRocket's optimisation parameter (apogee, top speed...)
 * as its goal has it, for a design (each modifier's value, scaled to 0..1, as OpenRocket's
 * optimiser has them), within limits on its stability and, new here, its fins' flutter margin.
 *
 * <p>Unlike OpenRocket's own (RocketOptimizationFunction), every design flies in the same gusts:
 * the simulation's own. OpenRocket's copies each design's simulation with duplicateSimulation,
 * whose wind gets a new random seed (copyConditionsFrom copies the wind's speed, deviation and
 * direction, but not the seed of its turbulence), so each design flew in different gusts: the
 * same design twice gave apogees a few tenths of a per cent apart, more than many of the
 * differences the optimiser was comparing. Here the simulation's options are cloned, which keeps
 * the seed: the same design always gives the same result, as running the simulation would.
 *
 * <p>Its simulations' time step is no coarser than OpenRocket's recommended one (0.05 s; half that
 * with several stages): with coarser ones, events such as burnout and staging land on the steps, so
 * results jump about as a design changes, and the search chases the jumps.
 *
 * <p>Stability is worked out as OpenRocket's stability limit does (StabilityDomain: the worst
 * centre of pressure at the default Mach number, the centre of gravity at launch, calibers of the
 * widest body), and as there, a design outside the stability limits is not simulated. The flutter
 * margin is the lowest of each fin set's flutter speed (FinFlutter, with its material's shear
 * modulus: entered on the Flutter tab, or its typical one) over the airspeed along the flight of
 * its stage. Fin sets without a shear modulus are left out (`unchecked` names them).
 */
public final class RocketObjective {
	/** The limits; NaN for none. */
	public static final class Limits {
		public double minStability = Double.NaN, maxStability = Double.NaN;
		/** Whether each stability limit is a length (m) rather than calibers. */
		public boolean minAbsolute, maxAbsolute;
		/** The lowest flutter speed over airspeed. */
		public double minFlutter = Double.NaN;

		boolean flutter() {
			return minFlutter > 0;
		}
	}

	/** One design, evaluated. */
	public static final class Evaluation {
		/** Every modifier's value, scaled. */
		public final double[] scaled;
		/** Every modifier's value, in SI units. */
		public final double[] values;
		/** The parameter (NaN: not simulated, or failed) and what the search makes lowest. */
		public double parameter = Double.NaN, goal = Double.NaN;
		/** Stability: calibers, and the length (m). */
		public double stability = Double.NaN, stabilityLength = Double.NaN;
		/** The lowest flutter speed over airspeed (NaN: not simulated, or no fins checked). */
		public double flutter = Double.NaN;
		/** Why the simulation failed, if it did. */
		public String failure;
		public ConstrainedSearch.Score score;

		Evaluation(double[] scaled, int n) {
			this.scaled = scaled;
			this.values = new double[n];
		}

		public boolean simulated() {
			return !Double.isNaN(parameter);
		}
	}

	private final Simulation base;
	private final Rocket template;
	private final SimulationOptions options;
	private final OptimizableParameter parameter;
	private final OptimizationGoal goal;
	private final Limits limits;
	private final SimulationModifier[] modifiers;
	private final Runnable pause;
	/** Indices of the modifiers the search varies (those with a range). */
	private final int[] varied;

	/**
	 * Copies what it needs from `base` (its rocket and options), so make it where the design may
	 * be read; then it may evaluate elsewhere. `pause` is called during each simulation step (a
	 * browser's window stays responsive if it sleeps now and then).
	 */
	public RocketObjective(Simulation base, OptimizableParameter parameter, OptimizationGoal goal, Limits limits,
			SimulationModifier[] modifiers, Runnable pause) {
		this.base = base;
		this.template = base.getRocket().copyWithOriginalID();
		this.options = base.getOptions().clone();
		// No coarser than OpenRocket's recommended time step: with coarser ones events (burnout,
		// staging) fall on the steps, so results jump about as a design changes (by up to 1.5 %
		// with the two stage example's 0.2 s), and an optimiser chases the jumps.
		// With several stages, half that: the upper stage's ignition still moves in steps at 0.05 s.
		double finest = base.getActiveConfiguration().getActiveStageCount() > 1 ? RK4SimulationStepper.RECOMMENDED_TIME_STEP / 2
				: RK4SimulationStepper.RECOMMENDED_TIME_STEP;
		if (!(options.getTimeStep() <= finest)) {
			options.setTimeStep(finest);
		}
		this.parameter = parameter;
		this.goal = goal;
		this.limits = limits != null ? limits : new Limits();
		this.modifiers = modifiers.clone();
		this.pause = pause != null ? pause : () -> {
		};
		List<Integer> v = new ArrayList<>();
		for (int i = 0; i < modifiers.length; i++) {
			if (!MathUtil.equals(modifiers[i].getMinValue(), modifiers[i].getMaxValue())) {
				v.add(i);
			}
		}
		varied = v.stream().mapToInt(Integer::intValue).toArray();
	}

	public int dimensions() {
		return varied.length;
	}

	/** The modifiers' current scaled values in the base simulation. */
	public double[] current() throws OptimizationException {
		double[] p = new double[modifiers.length];
		for (int i = 0; i < p.length; i++) {
			p[i] = modifiers[i].getCurrentScaledValue(base);
		}
		return p;
	}

	/** A copy of the base simulation for a design: the rocket as it was, the same options (and gusts). */
	public Simulation instance() {
		List<SimulationExtension> extensions = new ArrayList<>();
		for (SimulationExtension e : base.getSimulationExtensions()) {
			extensions.add(e.clone());
		}
		Simulation s = new Simulation(null, template.copyWithOriginalID(), Simulation.Status.NOT_SIMULATED, base.getName(),
				options.clone(), extensions, null);
		s.setFlightConfigurationId(base.getFlightConfigurationId());
		return s;
	}

	/** Evaluates a design: every modifier's scaled value (fixed modifiers at their only value). */
	public Evaluation evaluate(double[] scaled) throws InterruptedException, OptimizationException {
		Evaluation e = new Evaluation(scaled.clone(), modifiers.length);
		Simulation sim = instance();
		for (int i = 0; i < modifiers.length; i++) {
			modifiers[i].modify(sim, scaled[i]);
			e.values[i] = modifiers[i].getCurrentSIValue(sim);
		}
		List<Double> slack = new ArrayList<>();
		boolean stabilityLimits = !Double.isNaN(limits.minStability) || !Double.isNaN(limits.maxStability);
		stability(sim, e);
		double diameter = e.stabilityLength / e.stability;
		if (!Double.isNaN(limits.minStability)) {
			slack.add(limits.minAbsolute ? (e.stabilityLength - limits.minStability) / diameter : e.stability - limits.minStability);
		}
		if (!Double.isNaN(limits.maxStability)) {
			slack.add(limits.maxAbsolute ? (limits.maxStability - e.stabilityLength) / diameter : limits.maxStability - e.stability);
		}
		boolean within = true;
		for (double s : slack) {
			within &= s >= 0 || Double.isNaN(s);
		}
		boolean nan = stabilityLimits && Double.isNaN(e.stability);
		if (within && !nan) {
			simulate(sim, e);
		}
		if (limits.flutter()) {
			slack.add(Double.isNaN(e.flutter) ? (e.simulated() ? 1 : Double.NaN) : e.flutter - limits.minFlutter);
		}
		double[] s = new double[slack.size()];
		for (int i = 0; i < s.length; i++) {
			s[i] = slack.get(i);
		}
		if (nan) {
			Arrays.fill(s, Double.NaN);
			e.failure = "No stability (no centre of pressure or gravity)";
		}
		e.score = new ConstrainedSearch.Score(e.goal, s, e);
		return e;
	}

	/** Stability as OpenRocket's stability limit has it. */
	private static void stability(Simulation sim, Evaluation e) {
		FlightConfiguration config = sim.getActiveConfiguration();
		FlightConditions conditions = new FlightConditions(config);
		conditions.setMach(Application.getPreferences().getDefaultMach());
		conditions.setAOA(0);
		conditions.setRollRate(0);
		Coordinate cp = new BarrowmanCalculator().getWorstCP(config, conditions, null);
		Coordinate cg = MassCalculator.calculateLaunch(config).getCM();
		double cpx = cp.weight > 0.000001 ? cp.x : Double.NaN, cgx = cg.weight > 0.000001 ? cg.x : Double.NaN;
		double diameter = 0;
		for (RocketComponent c : config.getActiveComponents()) {
			if (c instanceof SymmetricComponent) {
				SymmetricComponent s = (SymmetricComponent) c;
				diameter = MathUtil.max(diameter, s.getForeRadius() * 2, s.getAftRadius() * 2);
			}
		}
		e.stabilityLength = cpx - cgx;
		e.stability = e.stabilityLength / diameter;
	}

	/** Simulates the design for its parameter (and flutter margin). */
	private void simulate(Simulation sim, Evaluation e) throws InterruptedException, OptimizationException {
		SimulationListener pausing = new AbstractSimulationListener() {
			@Override
			public void postStep(SimulationStatus status) throws SimulationException {
				if (Thread.currentThread().isInterrupted()) {
					throw new SimulationCancelledException("The optimization was stopped.");
				}
				pause.run();
			}
		};
		try {
			if (parameter instanceof SimulationBasedParameter) {
				SimulationListener[] own = (SimulationListener[]) invoke(parameter, "getSimulationListeners");
				SimulationListener[] all = Arrays.copyOf(own, own.length + 1);
				all[own.length] = pausing;
				sim.simulate(all);
				e.parameter = (Double) invoke(parameter, "getResultValue", sim.getSimulatedData());
			} else {
				e.parameter = parameter.computeValue(sim);
				if (limits.flutter()) {
					sim.simulate(new ApogeeEndListener(), pausing);
				}
			}
			if (limits.flutter() && sim.getSimulatedData() != null) {
				e.flutter = flutter(sim);
			}
		} catch (SimulationCalculationException ex) {
			e.parameter = Double.NaN;
			e.failure = ex.getMessage() != null ? ex.getMessage() : ex.toString();
		} catch (SimulationCancelledException ex) {
			throw (InterruptedException) new InterruptedException("The optimization was stopped.").initCause(ex);
		} catch (SimulationException ex) {
			throw new OptimizationException(ex);
		}
		e.goal = Double.isNaN(e.parameter) ? Double.NaN : goal.getMinimizationParameter(e.parameter);
		if (Double.isNaN(e.goal) && e.failure == null) {
			e.failure = "The simulation gave no value";
		}
	}

	private static Object invoke(Object target, String name, Object... args) throws OptimizationException {
		try {
			for (Class<?> c = target.getClass(); c != null; c = c.getSuperclass()) {
				for (Method m : c.getDeclaredMethods()) {
					if (m.getName().equals(name) && m.getParameterCount() == args.length) {
						m.setAccessible(true);
						return m.invoke(target, args);
					}
				}
			}
		} catch (IllegalAccessException ex) {
			throw new OptimizationException(ex);
		} catch (InvocationTargetException ex) {
			throw new OptimizationException(ex.getCause());
		}
		throw new OptimizationException("No " + name + " in " + target.getClass().getName());
	}

	/**
	 * The lowest flutter margin of the active fin sets with a shear modulus, each along the flight
	 * of its stage (NaN if none).
	 */
	static double flutter(Simulation sim) {
		FlightData data = sim.getSimulatedData();
		double lowest = Double.NaN;
		double launch = sim.getOptions().getLaunchAltitude();
		for (RocketComponent c : sim.getActiveConfiguration().getActiveComponents()) {
			if (!(c instanceof FinSet)) {
				continue;
			}
			FinSet fins = (FinSet) c;
			double g = FinFlutter.shearModulus(fins);
			FinFlutter fin = FinFlutter.of(fins);
			if (!(g > 0) || !fin.valid()) {
				continue;
			}
			double m = margin(branch(data, fins), launch, fin, g);
			if (!Double.isNaN(m) && !(m >= lowest)) {
				lowest = m;
			}
		}
		return lowest;
	}

	/** The fin sets the flutter limit cannot check: no shear modulus for their material, or no thickness. */
	public static List<FinSet> unchecked(FlightConfiguration config) {
		List<FinSet> out = new ArrayList<>();
		for (RocketComponent c : config.getActiveComponents()) {
			if (c instanceof FinSet && (!(FinFlutter.shearModulus((FinSet) c) > 0) || !FinFlutter.of((FinSet) c).valid())) {
				out.add((FinSet) c);
			}
		}
		return out;
	}

	/** The flight of the fins' stage (it flies with the rest until it separates). */
	static FlightDataBranch branch(FlightData data, FinSet fins) {
		FlightDataBranch b = data.getBranch(0);
		String stage = fins.getStage().getName();
		for (int i = 0; i < data.getBranchCount(); i++) {
			if (stage.equals(data.getBranch(i).getName())) {
				b = data.getBranch(i);
			}
		}
		return b;
	}

	/** The lowest flutter speed over airspeed along a flight (airspeed: Mach number times the speed of sound). */
	static double margin(FlightDataBranch b, double launchAltitude, FinFlutter fin, double g) {
		List<Double> alt = b.get(FlightDataType.TYPE_ALTITUDE), mach = b.get(FlightDataType.TYPE_MACH_NUMBER);
		List<Double> total = b.get(FlightDataType.TYPE_VELOCITY_TOTAL), pressure = b.get(FlightDataType.TYPE_AIR_PRESSURE);
		List<Double> sound = b.get(FlightDataType.TYPE_SPEED_OF_SOUND);
		int n = b.getLength();
		double[] v = new double[n], p = new double[n], a = new double[n];
		for (int i = 0; i < n; i++) {
			double h = at(alt, i);
			double[] standard = FinFlutter.standardAir(launchAltitude + (Double.isNaN(h) ? 0 : h));
			p[i] = at(pressure, i) > 0 ? at(pressure, i) : standard[0];
			a[i] = at(sound, i) > 0 ? at(sound, i) : standard[1];
			double m = at(mach, i);
			v[i] = m >= 0 ? m * a[i] : at(total, i);
		}
		FinFlutter.Margin m = fin.lowest(g, v, p, a);
		return m == null ? Double.NaN : m.factor;
	}

	private static double at(List<Double> values, int i) {
		if (values == null || i >= values.size()) {
			return Double.NaN;
		}
		Double d = values.get(i);
		return d == null ? Double.NaN : d;
	}

	/** The stability as OpenRocket's optimiser describes it (calibers, or a length when both limits are lengths). */
	public Value stabilityValue(Evaluation e) {
		boolean length = (!Double.isNaN(limits.minStability) || !Double.isNaN(limits.maxStability))
				&& (Double.isNaN(limits.minStability) || limits.minAbsolute) && (Double.isNaN(limits.maxStability) || limits.maxAbsolute);
		return length ? new Value(e.stabilityLength, UnitGroup.UNITS_LENGTH) : new Value(e.stability, UnitGroup.UNITS_STABILITY_CALIBERS);
	}

	/** Told of each design evaluated and each round of the search; may stop it. */
	public interface Listener {
		default void evaluated(Evaluation e) {
		}

		/** After each round: the best design before and now, and the step. */
		default void stepped(Evaluation from, Evaluation to, double step) {
		}

		default boolean stop() {
			return false;
		}
	}

	/** What optimising came to. */
	public static final class Outcome {
		/** The design as it was, and the best found. */
		public Evaluation start, best;
		public int tries;
		public boolean converged, stopped;
	}

	/** Searches the modifiers' ranges from the base simulation's design for the best one. */
	public Outcome optimize(ConstrainedSearch.Settings settings, Listener listener) throws InterruptedException, OptimizationException {
		Listener l = listener != null ? listener : new Listener() {
		};
		double[] start = current();
		Evaluation[] first = { null };
		ConstrainedSearch.Problem problem = problem(start, e -> {
			if (first[0] == null) {
				first[0] = e;
			}
			l.evaluated(e);
		});
		ConstrainedSearch.Result r;
		try {
			r = ConstrainedSearch.minimize(reduce(start), problem, settings, new ConstrainedSearch.Monitor() {
				@Override
				public void stepped(double[] from, ConstrainedSearch.Score fromScore, double[] to, ConstrainedSearch.Score toScore, double step) {
					l.stepped((Evaluation) fromScore.detail, (Evaluation) toScore.detail, step);
				}

				@Override
				public boolean stop() {
					return l.stop() || Thread.currentThread().isInterrupted();
				}
			});
		} catch (IllegalStateException ex) {
			if (ex.getCause() instanceof OptimizationException) {
				throw (OptimizationException) ex.getCause();
			}
			throw ex;
		}
		Outcome o = new Outcome();
		o.start = first[0];
		o.best = (Evaluation) r.score.detail;
		o.tries = r.tries;
		o.converged = r.converged;
		o.stopped = r.stopped;
		return o;
	}

	/** What the search tries: the varied modifiers' scaled values. */
	public ConstrainedSearch.Problem problem(double[] start, java.util.function.Consumer<Evaluation> evaluated) {
		return u -> {
			try {
				Evaluation e = evaluate(expand(start, u));
				if (evaluated != null) {
					evaluated.accept(e);
				}
				return e.score;
			} catch (OptimizationException ex) {
				throw new IllegalStateException(ex);
			}
		};
	}

	/** The varied modifiers' part of a design's scaled values. */
	public double[] reduce(double[] all) {
		double[] u = new double[varied.length];
		for (int k = 0; k < varied.length; k++) {
			u[k] = all[varied[k]];
		}
		return u;
	}

	/** The whole design for the varied modifiers' values u, the rest as in `start`. */
	public double[] expand(double[] start, double[] u) {
		double[] all = start.clone();
		for (int k = 0; k < varied.length; k++) {
			all[varied[k]] = u[k];
		}
		for (int i = 0; i < all.length; i++) {
			if (MathUtil.equals(modifiers[i].getMinValue(), modifiers[i].getMaxValue())) {
				all[i] = 0.5;
			}
		}
		return all;
	}
}
