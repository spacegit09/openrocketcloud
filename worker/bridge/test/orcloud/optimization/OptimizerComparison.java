package orcloud.optimization;

import java.io.File;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.jar.JarFile;

import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.file.GeneralRocketLoader;
import info.openrocket.core.optimization.general.FunctionOptimizer;
import info.openrocket.core.optimization.general.ParallelExecutorCache;
import info.openrocket.core.optimization.general.Point;
import info.openrocket.core.optimization.general.multidim.MultidirectionalSearchOptimizer;
import info.openrocket.core.optimization.general.onedim.GoldenSectionSearchOptimizer;
import info.openrocket.core.optimization.rocketoptimization.OptimizableParameter;
import info.openrocket.core.optimization.rocketoptimization.OptimizationGoal;
import info.openrocket.core.optimization.rocketoptimization.RocketOptimizationFunction;
import info.openrocket.core.optimization.rocketoptimization.SimulationDomain;
import info.openrocket.core.optimization.rocketoptimization.SimulationModifier;
import info.openrocket.core.optimization.rocketoptimization.domains.IdentitySimulationDomain;
import info.openrocket.core.optimization.rocketoptimization.domains.StabilityDomain;
import info.openrocket.core.optimization.rocketoptimization.goals.MaximizationGoal;
import info.openrocket.core.optimization.rocketoptimization.goals.MinimizationGoal;
import info.openrocket.core.optimization.rocketoptimization.goals.ValueSeekGoal;
import info.openrocket.core.optimization.rocketoptimization.modifiers.GenericComponentModifier;
import info.openrocket.core.optimization.rocketoptimization.parameters.GroundHitVelocityParameter;
import info.openrocket.core.optimization.rocketoptimization.parameters.MaximumAltitudeParameter;
import info.openrocket.core.optimization.rocketoptimization.parameters.MaximumVelocityParameter;
import info.openrocket.core.optimization.services.OptimizationServiceHelper;
import info.openrocket.core.rocketcomponent.FinSet;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.unit.UnitGroup;

/**
 * Compares OpenRocket's own optimiser (multidirectional search, or golden section for one
 * variable, with its stability domain, run as its dialog runs it) with ours (ConstrainedSearch on
 * RocketObjective) on the bundled examples: the best design each finds, judged as the user would
 * see it (the simulation run again, in its own gusts), against the best known (ours, searching
 * long and finely), whether it keeps to the limits, and what it took. Problems with a flutter
 * limit show what OpenRocket's optimiser, which has none, comes to there.
 *   java -cp OpenRocket.jar:classes orcloud.optimization.OptimizerComparison [problem name part]
 */
public final class OptimizerComparison {
	public static final class Problem {
		public final String name, example;
		public final int simulation;
		final String[][] modifiers; // component name, modifier name; optional third: min, fourth: max (SI)
		public final OptimizableParameter parameter;
		public final OptimizationGoal goal;
		public final RocketObjective.Limits limits = new RocketObjective.Limits();

		public Problem(String name, String example, int simulation, OptimizableParameter parameter, OptimizationGoal goal, String[]... modifiers) {
			this.name = name;
			this.example = example;
			this.simulation = simulation;
			this.parameter = parameter;
			this.goal = goal;
			this.modifiers = modifiers;
		}

		Problem stability(double min, double max, boolean absolute) {
			limits.minStability = min;
			limits.maxStability = max;
			limits.minAbsolute = absolute;
			limits.maxAbsolute = absolute;
			return this;
		}

		Problem flutter(double min) {
			limits.minFlutter = min;
			return this;
		}
	}

	public static final String[] ROOT = { "*fin*", "Root chord" }, TIP = { "*fin*", "Tip chord" }, HEIGHT = { "*fin*", "Height" },
			SWEEP = { "*fin*", "Sweep" }, THICKNESS = { "*fin*", "Thickness" };

	public static List<Problem> problems() {
		List<Problem> list = new ArrayList<>();
		list.add(new Problem("fins for apogee, stability >= 1.5", "A simple model rocket", 0, new MaximumAltitudeParameter(),
				new MaximizationGoal(), ROOT, TIP, HEIGHT, SWEEP).stability(1.5, Double.NaN, false));
		list.add(new Problem("fins for top speed, 1.5 <= stability <= 2", "A simple model rocket", 0, new MaximumVelocityParameter(),
				new MaximizationGoal(), ROOT, TIP, HEIGHT, SWEEP).stability(1.5, 2.0, false));
		list.add(new Problem("fins, nose and body for apogee (6 variables)", "A simple model rocket", 0, new MaximumAltitudeParameter(),
				new MaximizationGoal(), ROOT, TIP, HEIGHT, SWEEP, new String[] { "Nose cone", "Length" },
				new String[] { "Body tube", "Length" }).stability(1.5, Double.NaN, false));
		list.add(new Problem("nose cone length alone (1 variable), stability >= 3", "A simple model rocket", 0,
				new MaximumAltitudeParameter(), new MaximizationGoal(), new String[] { "Nose cone", "Length" }).stability(3, Double.NaN, false));
		list.add(new Problem("parachute for the softest landing (best at its range's end)", "A simple model rocket", 0,
				new GroundHitVelocityParameter(), new MinimizationGoal(), new String[] { "Parachute", "Diameter" }));
		list.add(new Problem("apogee of exactly 45 m (seek)", "A simple model rocket", 0, new MaximumAltitudeParameter(),
				new ValueSeekGoal(45), new String[] { "Nose cone", "Length" }, new String[] { "Body tube", "Length" }));
		list.add(new Problem("start too unstable for its limit (>= 3.5)", "A simple model rocket", 0, new MaximumAltitudeParameter(),
				new MaximizationGoal(), ROOT, TIP, HEIGHT, SWEEP).stability(3.5, Double.NaN, false));
		list.add(new Problem("a limit no design meets (stability >= 20)", "A simple model rocket", 0, new MaximumAltitudeParameter(),
				new MaximizationGoal(), ROOT, HEIGHT).stability(20, Double.NaN, false));
		list.add(new Problem("stability as a length (>= 4 cm)", "A simple model rocket", 0, new MaximumAltitudeParameter(),
				new MaximizationGoal(), ROOT, TIP, HEIGHT, SWEEP).stability(0.04, Double.NaN, true));
		list.add(new Problem("a range not holding the design (root chord 60-100 mm)", "A simple model rocket", 0,
				new MaximumAltitudeParameter(), new MaximizationGoal(), new String[] { "*fin*", "Root chord", "0.06", "0.1" }, HEIGHT)
				.stability(1.5, Double.NaN, false));
		list.add(new Problem("elliptical fins for top speed, 1.5 <= stability <= 2.5", "Clustered motors", 0,
				new MaximumVelocityParameter(), new MaximizationGoal(), new String[] { "*fin*", "Root chord" },
				new String[] { "*fin*", "Height" }).stability(1.5, 2.5, false));
		list.add(new Problem("high power fins for apogee, stability >= 1.5", "Dual parachute deployment", 0,
				new MaximumAltitudeParameter(), new MaximizationGoal(), ROOT, TIP, HEIGHT, SWEEP, THICKNESS).stability(1.5, Double.NaN, false));
		list.add(new Problem("the same, flutter margin >= 1.5", "Dual parachute deployment", 0, new MaximumAltitudeParameter(),
				new MaximizationGoal(), ROOT, TIP, HEIGHT, SWEEP, THICKNESS).stability(1.5, Double.NaN, false).flutter(1.5));
		list.add(new Problem("two stages: sustainer fins for apogee", "Two stage high power rocket", 0, new MaximumAltitudeParameter(),
				new MaximizationGoal(), ROOT, TIP, HEIGHT).stability(1.5, Double.NaN, false));
		return list;
	}

	public static void main(String[] args) throws Exception {
		orcloud.flight.Core.start();
		String only = args.length > 0 ? args[0] : null;
		System.out.println("problem | OpenRocket's: value (it reported), limits, simulations | ours: value, limits, simulations | best known");
		for (Problem p : problems()) {
			if (only != null && !p.name.contains(only)) {
				continue;
			}
			run(p);
		}
	}

	static void run(Problem p) throws Exception {
		OpenRocketDocument doc = load(p.example);
		Simulation sim = doc.getSimulations().get(p.simulation);
		SimulationModifier[] mods = modifiers(doc, p);
		for (SimulationModifier m : mods) {
			m.initialize(sim);
		}
		RocketObjective judge = new RocketObjective(sim, p.parameter, p.goal, p.limits, mods, null);

		// OpenRocket's.
		long t0 = System.nanoTime();
		double[] defaultPoint = runDefault(sim, p, mods);
		double defaultSeconds = (System.nanoTime() - t0) / 1e9;
		RocketObjective.Evaluation d = judge.evaluate(defaultPoint);

		// Ours.
		int[] sims = { 0 };
		t0 = System.nanoTime();
		RocketObjective ours = new RocketObjective(sim, p.parameter, p.goal, p.limits, mods, null);
		RocketObjective.Outcome o = ours.optimize(null, new RocketObjective.Listener() {
			@Override
			public void evaluated(RocketObjective.Evaluation e) {
				if (e.simulated() || e.failure != null) {
					sims[0]++;
				}
			}
		});
		double oursSeconds = (System.nanoTime() - t0) / 1e9;

		// The best known: ours, longer and finer, from a few starts.
		RocketObjective.Evaluation known = o.best;
		for (long seed = 1; seed <= 2; seed++) {
			ConstrainedSearch.Settings fine = new ConstrainedSearch.Settings();
			fine.tolerance = 1e-4;
			fine.budget = 1500;
			fine.seed = seed;
			RocketObjective.Evaluation e = new RocketObjective(sim, p.parameter, p.goal, p.limits, mods, null).optimize(fine, null).best;
			if (ConstrainedSearch.better(e.score, known.score)) {
				known = e;
			}
		}
		if (ConstrainedSearch.better(d.score, known.score)) {
			known = d;
		}
		String unit = p.parameter.getUnitGroup().getDefaultUnit().getUnit();
		System.out.println(String.format(Locale.ROOT, "%s (%s, %s):", p.name, p.example, describe(mods)));
		System.out.println(String.format(Locale.ROOT, "  start      %s", show(o.start, p, unit)));
		System.out.println(String.format(Locale.ROOT, "  OpenRocket %s  [%d simulations of %d designs, %.1f s; it reported %s]", show(d, p, unit),
				lastDefaultSims, lastDefaultDesigns, defaultSeconds, String.format(Locale.ROOT, "%.3f", lastDefaultReported)));
		System.out.println(String.format(Locale.ROOT, "  ours       %s  [%d simulations of %d designs, %.1f s%s]", show(o.best, p, unit), sims[0], o.tries,
				oursSeconds, o.converged ? "" : ", not converged"));
		System.out.println(String.format(Locale.ROOT, "  best known %s", show(known, p, unit)));
		System.out.println(String.format(Locale.ROOT, "  gap to best known: OpenRocket %s, ours %s", gap(d, known, p), gap(o.best, known, p)));
		System.out.println(String.format(Locale.ROOT, "  design: OpenRocket %s | ours %s | best %s", values(d, mods), values(o.best, mods), values(known, mods)));
	}

	static int lastDefaultSims, lastDefaultDesigns;
	static double lastDefaultReported;

	/** OpenRocket's optimiser as its dialog runs it (OptimizationWorker): the best point's scaled values. */
	static double[] runDefault(Simulation sim, Problem p, SimulationModifier[] mods) throws Exception {
		SimulationDomain domain;
		if (!Double.isNaN(p.limits.minStability) || !Double.isNaN(p.limits.maxStability)) {
			boolean minAbs = Double.isNaN(p.limits.minStability) ? p.limits.maxAbsolute : p.limits.minAbsolute;
			boolean maxAbs = Double.isNaN(p.limits.maxStability) ? minAbs : p.limits.maxAbsolute;
			domain = new StabilityDomain(p.limits.minStability, minAbs, p.limits.maxStability, maxAbs);
		} else {
			domain = new IdentitySimulationDomain();
		}
		RocketOptimizationFunction f = new RocketOptimizationFunction(sim, p.parameter, p.goal, domain, mods);
		int[] counts = { 0, 0 };
		f.addRocketOptimizationListener((point, state, domainReference, parameterValue, goalValue) -> {
			counts[1]++;
			if (parameterValue != null) {
				counts[0]++;
			}
		});
		ParallelExecutorCache cache = new ParallelExecutorCache(1);
		cache.setFunction(f);
		FunctionOptimizer opt = mods.length == 1 ? new GoldenSectionSearchOptimizer(cache) : new MultidirectionalSearchOptimizer(cache);
		double[] current = new double[mods.length];
		for (int i = 0; i < mods.length; i++) {
			current[i] = mods[i].getCurrentScaledValue(sim);
		}
		opt.optimize(new Point(current), (oldPoint, oldValue, newPoint, newValue, stepSize) -> stepSize >= 0.005);
		lastDefaultSims = counts[0];
		lastDefaultDesigns = counts[1];
		double v = opt.getOptimumValue();
		lastDefaultReported = p.goal instanceof MaximizationGoal ? -v : v;
		((java.util.concurrent.ExecutorService) cache.getExecutor()).shutdownNow();
		return opt.getOptimumPoint().asArray();
	}

	static String show(RocketObjective.Evaluation e, Problem p, String unit) {
		StringBuilder s = new StringBuilder();
		s.append(Double.isNaN(e.parameter) ? "   (not simulated)" : String.format(Locale.ROOT, "%10.3f %s", e.parameter, unit));
		s.append(String.format(Locale.ROOT, ", stability %.3f cal (%.1f mm)", e.stability, e.stabilityLength * 1000));
		if (p.limits.minFlutter > 0) {
			s.append(String.format(Locale.ROOT, ", flutter %.3f", e.flutter));
		}
		s.append(e.score.feasible() ? ", within limits" : String.format(Locale.ROOT, ", PAST LIMITS by %.4f", e.score.violation));
		return s.toString();
	}

	static String gap(RocketObjective.Evaluation e, RocketObjective.Evaluation known, Problem p) {
		if (!e.score.feasible() && known.score.feasible()) {
			return "past limits";
		}
		if (p.goal instanceof ValueSeekGoal) {
			return String.format(Locale.ROOT, "%.4f off target", e.goal);
		}
		double g = Math.abs(e.parameter - known.parameter) / Math.abs(known.parameter);
		return String.format(Locale.ROOT, "%.3f%%", 100 * g);
	}

	static String values(RocketObjective.Evaluation e, SimulationModifier[] mods) {
		StringBuilder s = new StringBuilder();
		for (int i = 0; i < mods.length; i++) {
			s.append(String.format(Locale.ROOT, "%s%.2f", i == 0 ? "" : " ", mods[i].getUnitGroup() == UnitGroup.UNITS_LENGTH ? e.values[i] * 1000 : e.values[i]));
		}
		return s.toString();
	}

	static String describe(SimulationModifier[] mods) {
		StringBuilder s = new StringBuilder();
		for (int i = 0; i < mods.length; i++) {
			s.append(i == 0 ? "" : ", ").append(((RocketComponent) mods[i].getRelatedObject()).getName()).append(' ')
					.append(mods[i].getName().toLowerCase(Locale.ROOT));
		}
		return s.toString();
	}

	/** The problem's modifiers: from OpenRocket's list, plus fin thickness (which ours adds). */
	public static SimulationModifier[] modifiers(OpenRocketDocument doc, Problem p) {
		List<SimulationModifier> all = new ArrayList<>(OptimizationServiceHelper.getSimulationModifiers(doc));
		for (RocketComponent c : doc.getRocket()) {
			if (c instanceof FinSet) {
				SimulationModifier m = new GenericComponentModifier("Thickness", "Fin thickness", c, UnitGroup.UNITS_LENGTH, 1.0, c.getClass(),
						c.getID(), "Thickness");
				m.setMinValue(((FinSet) c).getThickness() / 2);
				m.setMaxValue(((FinSet) c).getThickness() * 2);
				all.add(m);
			}
		}
		List<SimulationModifier> out = new ArrayList<>();
		for (String[] spec : p.modifiers) {
			SimulationModifier found = null;
			for (SimulationModifier m : all) {
				RocketComponent c = (RocketComponent) m.getRelatedObject();
				boolean component = spec[0].equals("*fin*") ? c instanceof FinSet : c.getName().equals(spec[0]);
				if (component && m.getName().equals(spec[1]) && found == null) {
					found = m;
				}
			}
			if (found == null) {
				throw new IllegalArgumentException("No modifier " + spec[1] + " of " + spec[0] + " in " + p.example);
			}
			if (spec.length > 2) {
				found.setMinValue(Double.parseDouble(spec[2]));
				found.setMaxValue(Double.parseDouble(spec[3]));
			}
			out.add(found);
		}
		return out.toArray(new SimulationModifier[0]);
	}

	public static OpenRocketDocument load(String example) throws Exception {
		String jar = null;
		for (String p : System.getProperty("java.class.path").split(File.pathSeparator)) {
			if (p.endsWith("OpenRocket.jar") || p.endsWith("OpenRocket-24.12.jar")) {
				jar = p;
			}
		}
		try (JarFile jf = new JarFile(jar)) {
			Path file = Files.createTempFile("example", ".ork");
			try (InputStream in = jf.getInputStream(jf.getEntry("datafiles/examples/" + example + ".ork"))) {
				Files.copy(in, file, StandardCopyOption.REPLACE_EXISTING);
			}
			OpenRocketDocument doc = new GeneralRocketLoader(file.toFile()).load();
			Files.delete(file);
			return doc;
		}
	}
}
