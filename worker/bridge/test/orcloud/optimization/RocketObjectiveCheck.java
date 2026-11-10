package orcloud.optimization;

import java.util.List;

import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.material.Material;
import info.openrocket.core.optimization.rocketoptimization.SimulationModifier;
import info.openrocket.core.optimization.rocketoptimization.goals.MaximizationGoal;
import info.openrocket.core.optimization.rocketoptimization.parameters.MaximumAltitudeParameter;
import info.openrocket.core.optimization.rocketoptimization.parameters.StabilityParameter;
import info.openrocket.core.rocketcomponent.FinSet;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.simulation.FlightDataBranch;
import info.openrocket.core.simulation.FlightDataType;
import info.openrocket.core.simulation.listeners.system.ApogeeEndListener;
import orcloud.fins.FinFlutter;

/**
 * Checks what the rocket optimiser measures (RocketObjective): a design gives the same result each
 * time, and the same as running its simulation again (the simulation's own gusts); its stability
 * is OpenRocket's (StabilityParameter); its flutter margin is the fins' along a full flight; a
 * design outside the stability limits is not simulated; a fin set whose material has no known
 * shear modulus is left out of the flutter limit (and named); a booster's fins are checked along
 * the booster's flight from launch; the flutter limit with the stability parameter (no simulation
 * of its own) still simulates; a modifier with no range is left out of the search; a coarse time
 * step is made the recommended one; simulations pause now and then; and an interrupted thread
 * stops it.
 *   java -cp OpenRocket.jar:classes orcloud.optimization.RocketObjectiveCheck
 */
public final class RocketObjectiveCheck {
	private static int failures;

	public static void main(String[] args) throws Exception {
		orcloud.flight.Core.start();
		OpenRocketDocument doc = OptimizerComparison.load("A simple model rocket");
		Simulation sim = doc.getSimulations().get(0);
		OptimizerComparison.Problem p = new OptimizerComparison.Problem("check", "A simple model rocket", 0, new MaximumAltitudeParameter(),
				new MaximizationGoal(), OptimizerComparison.ROOT, OptimizerComparison.TIP, OptimizerComparison.HEIGHT, OptimizerComparison.SWEEP)
				.stability(1.5, Double.NaN, false).flutter(1.25);
		SimulationModifier[] mods = OptimizerComparison.modifiers(doc, p);
		int[] pauses = { 0 };
		RocketObjective obj = new RocketObjective(sim, p.parameter, p.goal, p.limits, mods, () -> pauses[0]++);
		double[] now = obj.current();

		// The same each time, and as the simulation run again.
		RocketObjective.Evaluation a = obj.evaluate(now), b = obj.evaluate(now);
		check(a.parameter == b.parameter && a.flutter == b.flutter, "same design, different results: " + a.parameter + " / " + b.parameter);
		Simulation again = sim.copy();
		again.simulate(new ApogeeEndListener());
		check(Math.abs(again.getSimulatedData().getBranch(0).getMaximum(FlightDataType.TYPE_ALTITUDE) - a.parameter) < 1e-9,
				"not as the simulation run again: " + a.parameter + " vs " + again.getSimulatedData().getBranch(0).getMaximum(FlightDataType.TYPE_ALTITUDE));
		check(pauses[0] > 0, "no pauses during the simulation");
		System.out.println(String.format("  as the simulation: apogee %.4f m, stability %.4f cal, flutter %.3f", a.parameter, a.stability, a.flutter));

		// Stability as OpenRocket's.
		double or = new StabilityParameter(false).computeValue(again);
		check(Math.abs(or - a.stability) < 1e-9, "stability " + a.stability + " vs OpenRocket's " + or);

		// The flutter margin along a full flight (not stopped at apogee) is the same.
		Simulation full = obj.instance();
		full.simulate();
		double fullMargin = RocketObjective.flutter(full);
		check(Math.abs(fullMargin - a.flutter) < 1e-9, "flutter margin " + a.flutter + " vs " + fullMargin + " over the whole flight");
		FinSet fins = null;
		for (RocketComponent c : full.getRocket()) {
			if (c instanceof FinSet) {
				fins = (FinSet) c;
			}
		}
		double g = FinFlutter.shearModulus(fins);
		FinFlutter.Margin m = FinFlutter.of(fins).lowest(g, speeds(full.getSimulatedData().getBranch(0)), pressures(full.getSimulatedData().getBranch(0)),
				sounds(full.getSimulatedData().getBranch(0)));
		check(Math.abs(m.factor - a.flutter) < 1e-9, "flutter margin " + a.flutter + " vs the Flutter tab's way " + m.factor);

		// Outside the stability limits: not simulated, past the limit by the shortfall.
		double[] small = now.clone();
		small[0] = 0;
		small[2] = 0;
		RocketObjective.Evaluation unstable = obj.evaluate(small);
		check(!unstable.simulated() && !unstable.score.feasible() && Math.abs(unstable.score.violation - (1.5 - unstable.stability)) < 1e-9,
				"too unstable a design: simulated " + unstable.simulated() + ", past by " + unstable.score.violation + ", stability " + unstable.stability);

		// A material with no known shear modulus: left out, and named.
		OpenRocketDocument doc2 = OptimizerComparison.load("A simple model rocket");
		for (RocketComponent c : doc2.getRocket()) {
			if (c instanceof FinSet) {
				((FinSet) c).setMaterial(Material.newMaterial(Material.Type.BULK, "Unobtainium", 1000, true));
			}
		}
		Simulation sim2 = doc2.getSimulations().get(0);
		List<FinSet> unchecked = RocketObjective.unchecked(sim2.getActiveConfiguration());
		check(unchecked.size() == 1 && unchecked.get(0).getMaterial().getName().equals("Unobtainium"), "unchecked fins: " + unchecked);
		RocketObjective obj2 = new RocketObjective(sim2, p.parameter, p.goal, p.limits, OptimizerComparison.modifiers(doc2, p), null);
		RocketObjective.Evaluation e2 = obj2.evaluate(obj2.current());
		check(Double.isNaN(e2.flutter) && e2.score.feasible() && e2.simulated(), "fins without a shear modulus: flutter " + e2.flutter
				+ ", within limits " + e2.score.feasible());

		// A booster's fins: along the booster's flight, from launch.
		OpenRocketDocument two = OptimizerComparison.load("Two stage high power rocket");
		Simulation twoSim = two.getSimulations().get(0);
		Simulation flown = new RocketObjective(twoSim, p.parameter, p.goal, p.limits, OptimizerComparison.modifiers(two, p), null).instance();
		flown.simulate();
		int boosters = 0;
		for (RocketComponent c : flown.getActiveConfiguration().getActiveComponents()) {
			if (c instanceof FinSet && c.getStage().getStageNumber() > 0) {
				FlightDataBranch branch = RocketObjective.branch(flown.getSimulatedData(), (FinSet) c);
				List<Double> t = branch.get(FlightDataType.TYPE_TIME);
				check(branch != flown.getSimulatedData().getBranch(0) && t.get(0) < 0.01,
						"booster fins: branch " + branch.getName() + " from " + t.get(0) + " s");
				boosters++;
			}
		}
		check(boosters > 0, "no booster fins in the two stage example");

		// The stability parameter (no simulation of its own) with the flutter limit: simulated for flutter.
		RocketObjective stab = new RocketObjective(sim, new StabilityParameter(false), new MaximizationGoal(), p.limits, mods, null);
		RocketObjective.Evaluation s = stab.evaluate(now);
		check(Math.abs(s.parameter - a.stability) < 1e-9 && Math.abs(s.flutter - a.flutter) < 1e-9,
				"stability parameter with the flutter limit: " + s.parameter + ", flutter " + s.flutter);

		// A modifier with no range: left out of the search, at its value.
		mods[1].setMinValue(0.03);
		mods[1].setMaxValue(0.03);
		RocketObjective fixed = new RocketObjective(sim, p.parameter, p.goal, p.limits, mods, null);
		check(fixed.dimensions() == 3, "dimensions with a fixed modifier: " + fixed.dimensions());
		double[] all = fixed.expand(now, fixed.reduce(now));
		check(Math.abs(fixed.evaluate(all).values[1] - 0.03) < 1e-12, "fixed modifier's value: " + fixed.evaluate(all).values[1]);

		// A coarse time step: the recommended one.
		Simulation coarse = sim.copy();
		coarse.getOptions().setTimeStep(0.2);
		check(new RocketObjective(coarse, p.parameter, p.goal, p.limits, mods, null).instance().getOptions().getTimeStep() == 0.05,
				"time step not made the recommended one");

		// An interrupted thread: stopped.
		Thread.currentThread().interrupt();
		boolean stopped = false;
		try {
			obj.evaluate(now);
		} catch (InterruptedException e) {
			stopped = true;
		}
		Thread.interrupted();
		check(stopped, "an interrupted thread did not stop the evaluation");

		System.out.println("ROCKETOBJECTIVECHECK " + (failures == 0 ? "PASS" : "FAILED " + failures));
		System.exit(failures == 0 ? 0 : 1);
	}

	private static double[] speeds(FlightDataBranch b) {
		List<Double> mach = b.get(FlightDataType.TYPE_MACH_NUMBER), sound = b.get(FlightDataType.TYPE_SPEED_OF_SOUND);
		double[] v = new double[mach.size()];
		for (int i = 0; i < v.length; i++) {
			v[i] = mach.get(i) * sound.get(i);
		}
		return v;
	}

	private static double[] pressures(FlightDataBranch b) {
		return b.get(FlightDataType.TYPE_AIR_PRESSURE).stream().mapToDouble(Double::doubleValue).toArray();
	}

	private static double[] sounds(FlightDataBranch b) {
		return b.get(FlightDataType.TYPE_SPEED_OF_SOUND).stream().mapToDouble(Double::doubleValue).toArray();
	}

	private static void check(boolean ok, String what) {
		if (!ok) {
			failures++;
			System.out.println("  FAIL " + what);
		}
	}
}
