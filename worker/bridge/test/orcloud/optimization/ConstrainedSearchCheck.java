package orcloud.optimization;

import java.util.function.Function;

/**
 * Checks the optimiser's search (ConstrainedSearch) on problems with known answers, and its edge
 * cases: a valley inside the box; one whose bottom lies past a limit (the answer on the limit);
 * two limits meeting; a curved limit; the bottom past the box (on its side, exactly); two valleys
 * (the deeper found); a start past a limit; no point within the limits (the one past them least);
 * tries that fail; values not worked out past a limit checked first; one variable against a limit
 * (found to 1e-4); a value to seek (|x - t|); a flat function; no variables; a start outside the
 * box; a curved valley (Rosenbrock's); its number of tries, and stopping when told.
 *   java -cp classes orcloud.optimization.ConstrainedSearchCheck
 */
public final class ConstrainedSearchCheck {
	private static int failures;

	public static void main(String[] args) throws Exception {
		// A valley at (0.3, 0.7).
		ConstrainedSearch.Result r = run(new double[] { 0.9, 0.1 }, x -> score(sq(x[0] - 0.3) + sq(x[1] - 0.7)));
		near("valley", r, new double[] { 0.3, 0.7 }, 2e-3);

		// The same valley, x + y at most 0.8: the bottom within it is (0.2, 0.6).
		r = run(new double[] { 0.1, 0.1 }, x -> score(sq(x[0] - 0.3) + sq(x[1] - 0.7), 0.8 - x[0] - x[1]));
		near("valley past a limit", r, new double[] { 0.2, 0.6 }, 3e-3);
		feasible("valley past a limit", r);

		// Three variables, two limits meeting: x + y + z at most 1.2, x at most 0.25.
		r = run(new double[] { 0.1, 0.1, 0.1 }, x -> score(-(3 * x[0] + x[1] + x[2] - 0.5 * (sq(x[1]) + sq(x[2]))),
				1.2 - x[0] - x[1] - x[2], 0.25 - x[0]));
		near("two limits", r, new double[] { 0.25, 0.475, 0.475 }, 5e-3);
		feasible("two limits", r);

		// A curved limit: within the circle of radius 0.5 about the middle, lowest towards (1, 1).
		double c = 0.5 + 0.5 / Math.sqrt(2);
		r = run(new double[] { 0.5, 0.5 }, x -> score(-(x[0] + x[1]), 0.25 - sq(x[0] - 0.5) - sq(x[1] - 0.5)));
		near("curved limit", r, new double[] { c, c }, 5e-3);
		feasible("curved limit", r);

		// Four variables, the bottom past the box: on its sides exactly.
		r = run(new double[] { 0.5, 0.5, 0.5, 0.5 }, x -> score(-(x[0] + 2 * x[1]) + sq(x[2] - 0.4) + sq(x[3] - 1.5)));
		check(r.u[0] == 1 && r.u[1] == 1 && r.u[3] == 1, "box sides: not exactly on them: " + str(r.u));
		near("box sides", r, new double[] { 1, 1, 0.4, 1 }, 2e-3);

		// Two valleys: a shallow one where it starts, a deeper one across the box.
		r = run(new double[] { 0.15, 0.15 }, x -> score(-Math.exp(-20 * (sq(x[0] - 0.15) + sq(x[1] - 0.15)))
				- 2 * Math.exp(-20 * (sq(x[0] - 0.8) + sq(x[1] - 0.75)))));
		near("two valleys", r, new double[] { 0.8, 0.75 }, 3e-3);

		// A start past a limit (x at least 0.6), the bottom at 0.2: the answer on the limit.
		r = run(new double[] { 0.1, 0.5 }, x -> score(sq(x[0] - 0.2) + sq(x[1] - 0.5), x[0] - 0.6));
		near("start past a limit", r, new double[] { 0.6, 0.5 }, 3e-3);
		feasible("start past a limit", r);

		// No point within the limit (x at least 2): the one past it least, x = 1.
		r = run(new double[] { 0 }, x -> score(x[0], x[0] - 2));
		check(!r.score.feasible() && r.u[0] == 1, "no point within the limit: " + str(r.u));

		// Tries failing beyond x + y = 1.2 (the simulation throws, say), the bottom at (0.9, 0.9) past them.
		r = run(new double[] { 0.2, 0.2 }, x -> x[0] + x[1] > 1.2 ? score(Double.NaN) : score(sq(x[0] - 0.9) + sq(x[1] - 0.9)));
		check(r.score.feasible() && !r.score.failed() && r.u[0] + r.u[1] <= 1.2 && r.u[0] + r.u[1] > 1.19,
				"failing tries: " + str(r.u));

		// Past a limit checked first, the value is not worked out (as with a rocket too unstable to fly).
		r = run(new double[] { 0.9, 0.9 }, x -> {
			double s = 0.8 - x[0] - x[1];
			return s < 0 ? score(Double.NaN, s) : score(sq(x[0] - 0.3) + sq(x[1] - 0.7), s);
		});
		near("value not worked out past the limit", r, new double[] { 0.2, 0.6 }, 3e-3);
		feasible("value not worked out past the limit", r);

		// One variable against a limit (x at most 0.6180340, the value falling with x): found to 1e-4.
		r = run(new double[] { 0.1 }, x -> score(-x[0] * (2 - x[0]), 0.6180340 - x[0]));
		check(Math.abs(r.u[0] - 0.618034) < 1e-4 && r.score.feasible(), "one variable against a limit: " + str(r.u) + " in " + r.tries);

		// A value to seek: |x0 + x1 - 0.9|.
		r = run(new double[] { 0, 0 }, x -> score(Math.abs(x[0] + x[1] - 0.9)));
		check(r.score.value < 2e-3, "seek: " + r.score.value + " at " + str(r.u));

		// Flat: stays where it starts.
		r = run(new double[] { 0.3, 0.4 }, x -> score(5));
		check(r.u[0] == 0.3 && r.u[1] == 0.4 && r.converged, "flat: " + str(r.u));

		// No variables.
		r = run(new double[0], x -> score(1));
		check(r.u.length == 0 && r.tries == 1 && r.converged, "no variables: " + r.tries + " tries");

		// A start outside the box (and NaN): in it.
		r = run(new double[] { -3, Double.NaN }, x -> {
			check(x[0] >= 0 && x[0] <= 1 && x[1] >= 0 && x[1] <= 1, "outside the box: tried " + str(x));
			return score(sq(x[0] - 0.5) + sq(x[1] - 0.5));
		});
		near("start outside the box", r, new double[] { 0.5, 0.5 }, 2e-3);

		// Rosenbrock's curved valley, scaled into the box: bottom at (0.6, 0.6).
		r = run(new double[] { 0.1, 0.9 }, x -> {
			double a = 4 * x[0] - 1.4, b = 4 * x[1] - 1.4; // (1, 1) at 0.6
			return score(sq(1 - a) + 100 * sq(b - a * a));
		});
		check(r.score.value < 1e-3, "Rosenbrock: " + r.score.value + " at " + str(r.u) + " in " + r.tries);

		// Its number of tries, and stopping when told.
		int[] calls = { 0 };
		ConstrainedSearch.Settings settings = new ConstrainedSearch.Settings();
		settings.budget = 37;
		r = ConstrainedSearch.minimize(new double[] { 0, 0, 0 }, x -> {
			calls[0]++;
			return score(Math.sin(9 * x[0]) + Math.cos(7 * x[1]) + x[2]);
		}, settings, null);
		check(calls[0] == 37 && r.tries == 37 && !r.converged, "tries: " + calls[0] + " of 37");
		calls[0] = 0;
		r = ConstrainedSearch.minimize(new double[] { 0 }, x -> {
			calls[0]++;
			return score(-x[0]);
		}, null, new ConstrainedSearch.Monitor() {
			@Override
			public boolean stop() {
				return calls[0] >= 5;
			}
		});
		check(calls[0] == 5 && r.stopped, "stopped after " + calls[0] + " tries, not 5");

		System.out.println("CONSTRAINEDSEARCHCHECK " + (failures == 0 ? "PASS" : "FAILED " + failures));
		System.exit(failures == 0 ? 0 : 1);
	}

	static ConstrainedSearch.Result run(double[] start, Function<double[], ConstrainedSearch.Score> f) throws InterruptedException {
		return ConstrainedSearch.minimize(start, f::apply, null, null);
	}

	static ConstrainedSearch.Score score(double value, double... slack) {
		return new ConstrainedSearch.Score(value, slack, null);
	}

	private static void near(String what, ConstrainedSearch.Result r, double[] expected, double tolerance) {
		boolean ok = true;
		for (int i = 0; i < expected.length; i++) {
			ok &= Math.abs(r.u[i] - expected[i]) <= tolerance;
		}
		System.out.println("  " + what + ": " + str(r.u) + " in " + r.tries + " tries");
		check(ok, what + ": found " + str(r.u));
	}

	private static void feasible(String what, ConstrainedSearch.Result r) {
		check(r.score.feasible(), what + ": past the limits");
	}

	static String str(double[] u) {
		StringBuilder s = new StringBuilder();
		for (double v : u) {
			s.append(String.format(" %.5f", v));
		}
		return s.toString().trim();
	}

	private static double sq(double v) {
		return v * v;
	}

	static void check(boolean ok, String what) {
		if (!ok) {
			failures++;
			System.out.println("  FAIL " + what);
		}
	}
}
