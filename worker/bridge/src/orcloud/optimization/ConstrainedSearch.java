package orcloud.optimization;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

/**
 * Finds the lowest value of a function over the unit box while keeping within limits: the search
 * behind our rocket optimiser, in place of OpenRocket's multidirectional search and golden section
 * search. Each try is a rocket simulation, so tries are counted and never repeated.
 *
 * <p>Where OpenRocket's search falls short, and what this one does instead:
 * <ul>
 * <li>A try past a limit (too little stability, say) only counts as worse than every try within
 * them, so the search contracts against the limit, which is where the best rockets usually are,
 * and stops short of the best along it. Here each limit has a slack (how far within it a try is,
 * negative past it), and the search steps along the limits it is at, onto them: the limits' slopes
 * come from the tries along the axes, and a step that lands past a curved limit is brought back
 * onto it along its slope (a second-order correction, as in SQP).</li>
 * <li>A try past the end of a range is thrown away, so the best on a range's end is never reached
 * exactly. Here a step past it stops at the end.</li>
 * <li>Its steps only ever shrink, and keep the shape of its first simplex. Here sweeps along each
 * axis are followed by moves on in the direction they went, further while they help (Hooke and
 * Jeeves' pattern search), and where sweeps no longer help, a quadratic model of the value fitted
 * to the tries nearby (how the variables interact too) gives a step to its lowest point within a
 * trust region, which grows while the model foresees the gains and shrinks when it does not.</li>
 * <li>It stops when its step is 0.5 % of the ranges; here at 0.1 %.</li>
 * <li>It only searches from where the rocket is (and golden section, with one variable, assumes
 * a single valley and ignores where it starts). Here it also tries a spread of points over the
 * ranges first (a Latin hypercube), and searches from the best of all, then roughly from the best
 * elsewhere, to the end if that leads somewhere better.</li>
 * </ul>
 * Tries are compared within the limits first, then by value, and past them by how far past.
 */
public final class ConstrainedSearch {
	/** One try: its value (to make lowest) and how far within each limit it is. */
	public static final class Score {
		/** NaN when not worked out (past a limit checked first) or when it failed. */
		public final double value;
		/** Per limit; negative past it, NaN when not worked out. */
		public final double[] slack;
		/** How far past the limits, in all (0: within all of them; infinite: failed). */
		public final double violation;
		public final Object detail;

		public Score(double value, double[] slack, Object detail) {
			this.value = value;
			this.slack = slack != null ? slack : new double[0];
			double v = 0;
			for (double s : this.slack) {
				if (s < 0) {
					v += -s;
				}
			}
			// A try that failed (no value, yet within every limit it was checked against).
			this.violation = Double.isNaN(value) && v == 0 ? Double.POSITIVE_INFINITY : v;
			this.detail = detail;
		}

		public boolean feasible() {
			return violation == 0;
		}

		public boolean failed() {
			return Double.isInfinite(violation);
		}
	}

	public interface Problem {
		Score evaluate(double[] u) throws InterruptedException;
	}

	/** Told of the search's progress; may stop it. */
	public interface Monitor {
		/** After each round of steps: where it was and is now (the best so far), and the step. */
		default void stepped(double[] from, Score fromScore, double[] to, Score toScore, double step) {
		}

		default boolean stop() {
			return false;
		}
	}

	public static final class Settings {
		/** The most tries. */
		public int budget = 400;
		/** The smallest step, as a share of each range. */
		public double tolerance = 1e-3;
		/** Whether to try a spread of points over the ranges first. */
		public boolean explore = true;
		public long seed = 20261110;
	}

	public static final class Result {
		public double[] u;
		public Score score;
		public int tries;
		/** Whether the step came down to the tolerance (rather than running out of tries or being stopped). */
		public boolean converged;
		public boolean stopped;
	}

	/**
	 * How far within a limit a step onto it aims: a twentieth of what a step changes the limit by,
	 * and no more than this (in the limit's units).
	 */
	static final double SLACK_AIM = 1e-3;
	/** The tolerance of a search from another valley, to see whether it is worth searching to the end. */
	private static final double ROUGH = 0.02;
	/** How far around a point (in steps) the tries its quadratic model is fitted to may be. */
	private static final double FIT = 2;
	/** How far (in steps) a model step may go. */
	private static final double TRUST = 3;

	private static final class Point {
		final double[] u;
		final Score score;

		Point(double[] u, Score score) {
			this.u = u;
			this.score = score;
		}
	}

	private final int n;
	private final Problem problem;
	private final Settings settings;
	private final Monitor monitor;
	private final Random random;
	private final Map<String, Point> tried = new HashMap<>();
	private final List<Point> order = new ArrayList<>();
	private Point best;
	private boolean stopped, converged;
	/** The limits the last model step stepped onto: which, their slopes, and how far within them it aimed. */
	private final List<Integer> limitIndex = new ArrayList<>();
	private final List<Double> limitAim = new ArrayList<>();
	private List<double[]> limitSlopes = new ArrayList<>();
	/** The change in value the last model step foresaw (NaN: none). */
	private double predicted = Double.NaN;

	private ConstrainedSearch(int n, Problem problem, Settings settings, Monitor monitor) {
		this.n = n;
		this.problem = problem;
		this.settings = settings != null ? settings : new Settings();
		this.monitor = monitor != null ? monitor : new Monitor() {
		};
		this.random = new Random(this.settings.seed);
	}

	/** Searches the unit box of `start.length` dimensions from `start`. */
	public static Result minimize(double[] start, Problem problem, Settings settings, Monitor monitor) throws InterruptedException {
		ConstrainedSearch s = new ConstrainedSearch(start.length, problem, settings, monitor);
		s.run(start);
		Result r = new Result();
		r.u = s.best.u.clone();
		r.score = s.best.score;
		r.tries = s.order.size();
		r.converged = s.converged;
		r.stopped = s.stopped;
		return r;
	}

	/** Whether a is a better try than b. */
	public static boolean better(Score a, Score b) {
		if (b == null) {
			return true;
		}
		if (a.feasible() != b.feasible()) {
			return a.feasible();
		}
		if (a.feasible()) {
			return a.value < b.value - 1e-12 * Math.max(1, Math.abs(b.value));
		}
		if (a.violation != b.violation) {
			return a.violation < b.violation;
		}
		return !Double.isNaN(a.value) && !Double.isNaN(b.value) && a.value < b.value;
	}

	private void run(double[] start) throws InterruptedException {
		double[] u0 = new double[n];
		for (int i = 0; i < n; i++) {
			u0[i] = Double.isNaN(start[i]) ? 0.5 : clamp(start[i]);
		}
		Point first = evaluate(u0);
		if (first == null || n == 0) {
			converged = n == 0;
			return;
		}
		List<Point> spread = new ArrayList<>();
		if (settings.explore) {
			int m = 2 * n + 2;
			double[][] lhs = latinHypercube(m);
			for (double[] u : lhs) {
				Point p = evaluate(u);
				if (p == null) {
					return;
				}
				spread.add(p);
			}
		}
		Point end = local(best, 0.25, settings.tolerance);
		if (end == null) {
			return;
		}
		converged = true;
		// Then, roughly, from the best try well away from there within the limits (another valley),
		// if any; and if that ends better, on to the tolerance.
		Point other = null;
		for (Point p : spread) {
			if (p.score.feasible() && distance(p.u, end.u) > 0.25 && (other == null || better(p.score, other.score))) {
				other = p;
			}
		}
		if (other != null) {
			Point rough = local(other, 0.25, ROUGH);
			if (rough != null && better(rough.score, end.score)) {
				local(rough, ROUGH, settings.tolerance);
			}
		}
	}

	/** A Latin hypercube of m points: each axis cut into m slices, each slice tried once. */
	private double[][] latinHypercube(int m) {
		double[][] points = new double[m][n];
		for (int i = 0; i < n; i++) {
			int[] slices = new int[m];
			for (int k = 0; k < m; k++) {
				slices[k] = k;
			}
			for (int k = m - 1; k > 0; k--) {
				int j = random.nextInt(k + 1);
				int t = slices[k];
				slices[k] = slices[j];
				slices[j] = t;
			}
			for (int k = 0; k < m; k++) {
				points[k][i] = (slices[k] + random.nextDouble()) / m;
			}
		}
		return points;
	}

	/**
	 * Hooke and Jeeves' pattern search from p, its step from `step` down to `tolerance`: a sweep
	 * along each axis in turn (keeping each step that helps), then, while sweeps help, moves on in
	 * the direction they went, further each time; when a sweep does not help, a step worked out
	 * from the tries around the point (modelStep), else half the step. Where it ends, or null when
	 * out of tries or stopped.
	 */
	private Point local(Point p, double step, double tolerance) throws InterruptedException {
		Point base = p;
		while (step >= tolerance) {
			Point[] plus = new Point[n], minus = new Point[n];
			Point x = sweep(base, step, plus, minus);
			if (x == null) {
				return null;
			}
			Point from = base;
			if (x != base) {
				// Pattern moves: on in the direction the sweep went, while it keeps helping.
				while (true) {
					double[] u = new double[n];
					for (int i = 0; i < n; i++) {
						u[i] = clamp(x.u[i] + (x.u[i] - base.u[i]));
					}
					base = x;
					if (same(u, x.u)) {
						break;
					}
					Point q = evaluate(u);
					if (q == null) {
						return null;
					}
					Point y = sweep(better(q.score, x.score) ? q : x, step, new Point[n], new Point[n]);
					if (y == null) {
						return null;
					}
					if (!better(y.score, x.score)) {
						break;
					}
					x = y;
				}
			} else {
				if (!Double.isNaN(base.score.value) && quadratic(base, FIT * step) == null && !fillIn(base, step)) {
					return null;
				}
				double[] d = modelStep(base, plus, minus, step);
				Point q = null;
				for (int attempt = 0; attempt < 2; attempt++) {
					if (d != null) {
						double[] u = new double[n];
						for (int i = 0; i < n; i++) {
							u[i] = clamp(base.u[i] + d[i]);
						}
						if (!same(u, base.u)) {
							q = evaluate(u);
							if (q == null) {
								return null;
							}
						}
					}
					// A step along a curved limit lands past it: back onto it along the limit's slope
					// (a second-order correction, as in SQP), once.
					if (q != null && !better(q.score, base.score) && base.score.feasible() && !q.score.failed() && !q.score.feasible()) {
						double[] d2 = d.clone();
						boolean corrected = false;
						for (int k = 0; k < limitIndex.size(); k++) {
							double sq = q.score.slack[limitIndex.get(k)];
							double[] gj = limitSlopes.get(k);
							if (sq < limitAim.get(k) && !Double.isNaN(sq)) {
								double g2 = dot(gj, gj);
								for (int i = 0; i < n; i++) {
									d2[i] += (limitAim.get(k) - sq) / g2 * gj[i];
								}
								corrected = true;
							}
						}
						if (corrected) {
							double[] u = new double[n];
							for (int i = 0; i < n; i++) {
								u[i] = clamp(base.u[i] + d2[i]);
							}
							if (!same(u, base.u)) {
								Point q2 = evaluate(u);
								if (q2 == null) {
									return null;
								}
								if (better(q2.score, base.score)) {
									q = q2;
									d = d2;
									break;
								}
							}
						}
					}
					// A model that misled, from tries too few or too far: once more, with the tries
					// along pairs of axes at this step too.
					if (attempt > 0 || d == null || n < 2 || Double.isNaN(base.score.value) || (q != null && better(q.score, base.score))) {
						break;
					}
					int before = order.size();
					if (!fillIn(base, step)) {
						return null;
					}
					if (order.size() == before) {
						break;
					}
					d = modelStep(base, plus, minus, step);
					q = null;
				}
				if (q != null && better(q.score, base.score)) {
					// How much of the gain the model foresaw: little, and it is trusted less (it may
					// otherwise creep, ever more slowly, towards a point that is not the lowest); much,
					// with a step to the edge of where it is trusted, and it is trusted further.
					double ratio = q.score.feasible() && base.score.feasible() && predicted < 0
							? (q.score.value - base.score.value) / predicted : 1;
					// Gaining next to nothing (a part in 1e8) is not getting anywhere: the lowest point
					// is about as near as the step.
					boolean slight = q.score.feasible() && base.score.feasible()
							&& base.score.value - q.score.value < 1e-8 * Math.abs(base.score.value) + 1e-300;
					// So is a step far shorter than the sweep's.
					double longest = 0;
					for (double v : d) {
						longest = Math.max(longest, Math.abs(v));
					}
					if (ratio < 0.25 || slight || longest < step / 4) {
						step /= 2;
					} else if (ratio > 0.75 && norm(d) >= 0.9 * TRUST * step) {
						step = Math.min(0.25, step * 2);
					}
					base = q;
				} else {
					step /= 2;
				}
			}
			monitor.stepped(from.u.clone(), from.score, best.u.clone(), best.score, step);
			if (monitor.stop()) {
				stopped = true;
				return null;
			}
		}
		return base;
	}

	/**
	 * Tries points that show a quadratic model around p how the variables interact: a step along
	 * pairs of axes together (towards the box's middle), each axis with the next (n tries, not all
	 * n(n - 1)/2 pairs). False when out of tries or stopped.
	 */
	private boolean fillIn(Point p, double step) throws InterruptedException {
		for (int i = 0; n > 1 && i < (n == 2 ? 1 : n); i++) {
			int j = (i + 1) % n;
			double[] u = p.u.clone();
			u[i] = clamp(u[i] + (u[i] < 0.5 ? step : -step));
			u[j] = clamp(u[j] + (u[j] < 0.5 ? step : -step));
			if (evaluate(u) == null) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Steps along each axis in turn from p (forward, else back), keeping each that helps: the best
	 * reached (p if none helped), or null when out of tries or stopped. Notes each try along an
	 * axis from p itself in plus or minus.
	 */
	private Point sweep(Point p, double step, Point[] plus, Point[] minus) throws InterruptedException {
		Point at = p;
		for (int i = 0; i < n; i++) {
			for (int sign = 1; sign >= -1; sign -= 2) {
				double[] u = at.u.clone();
				u[i] = clamp(u[i] + sign * step);
				if (same(u, at.u)) {
					continue;
				}
				Point q = evaluate(u);
				if (q == null) {
					return null;
				}
				if (at == p) {
					(sign > 0 ? plus : minus)[i] = q;
				}
				if (better(q.score, at.score)) {
					at = q;
					break;
				}
			}
		}
		return at;
	}

	/**
	 * A step from `at`, worked out from the tries around it: the slopes of the limits from the tries
	 * along the axes (at `step`), and a quadratic model of the value (slopes, curvatures and how
	 * they interact) fitted to the tries nearby, or the slopes and curvatures along the axes where
	 * too few are near. Within the limits it is the model's lowest point within a few steps, along
	 * the limits it is at or within a step of (and the box's sides), on them; past a limit it is onto
	 * the limits. Null without the slopes or anywhere to go.
	 */
	private double[] modelStep(Point at, Point[] plus, Point[] minus, double step) {
		int m = at.score.slack.length;
		double[] g = new double[n];
		double[][] h = new double[n][n];
		double[][] gs = new double[m][n];
		boolean[] slopeKnown = new boolean[m];
		Arrays.fill(slopeKnown, true);
		double f0 = at.score.value;
		boolean curvatures = !Double.isNaN(f0);
		for (int i = 0; i < n; i++) {
			Point a = plus[i], b = minus[i];
			if (a != null && a.score.failed()) {
				a = null;
			}
			if (b != null && b.score.failed()) {
				b = null;
			}
			double fa = a != null ? a.score.value : Double.NaN, fb = b != null ? b.score.value : Double.NaN;
			if (!Double.isNaN(fa) && !Double.isNaN(fb)) {
				double da = a.u[i] - at.u[i], db = b.u[i] - at.u[i];
				g[i] = (fa - fb) / (da - db);
				h[i][i] = Double.isNaN(f0) ? Double.NaN : 2 * ((fa - f0) / da - (fb - f0) / db) / (da - db);
			} else {
				if (!Double.isNaN(fa) && !Double.isNaN(f0)) {
					g[i] = (fa - f0) / (a.u[i] - at.u[i]);
				} else if (!Double.isNaN(fb) && !Double.isNaN(f0)) {
					g[i] = (fb - f0) / (b.u[i] - at.u[i]);
				}
				h[i][i] = Double.NaN;
			}
			curvatures &= !Double.isNaN(h[i][i]);
			for (int j = 0; j < m; j++) {
				double s0 = at.score.slack[j];
				double sa = a != null && a.score.slack.length == m ? a.score.slack[j] : Double.NaN;
				double sb = b != null && b.score.slack.length == m ? b.score.slack[j] : Double.NaN;
				if (!Double.isNaN(sa) && !Double.isNaN(sb)) {
					gs[j][i] = (sa - sb) / (a.u[i] - b.u[i]);
				} else if (!Double.isNaN(sa) && !Double.isNaN(s0)) {
					gs[j][i] = (sa - s0) / (a.u[i] - at.u[i]);
				} else if (!Double.isNaN(sb) && !Double.isNaN(s0)) {
					gs[j][i] = (sb - s0) / (b.u[i] - at.u[i]);
				} else if (a != null || b != null) {
					slopeKnown[j] = false;
				}
			}
		}
		// A better model of the value from the tries nearby, where there are enough of them.
		if (!Double.isNaN(f0)) {
			double[][] fit = quadratic(at, FIT * step);
			if (fit != null) {
				g = fit[0];
				for (int i = 0; i < n; i++) {
					h[i] = fit[i + 1];
				}
				curvatures = true;
			}
		}
		if (!curvatures) {
			for (int i = 0; i < n; i++) {
				h[i] = new double[n];
			}
		}
		// The limits in the way: past them, or within a step and the way down leading across them.
		limitIndex.clear();
		limitAim.clear();
		List<double[]> normals = new ArrayList<>();
		List<Double> wanted = new ArrayList<>();
		boolean past = false;
		double[] aim = new double[m];
		boolean[] near = new boolean[m];
		for (int j = 0; j < m; j++) {
			double s = at.score.slack[j];
			double norm = norm(gs[j]);
			if (!slopeKnown[j] || Double.isNaN(s) || norm < 1e-12) {
				continue;
			}
			aim[j] = Math.min(SLACK_AIM, 0.05 * step * norm);
			near[j] = s < 1.5 * step * norm;
			if (s < 0 || (near[j] && dot(gs[j], g) > 0)) {
				limitIndex.add(j);
				past |= s < 0;
			}
		}
		double radius = TRUST * step;
		double[] move;
		if (past || Double.isNaN(f0)) {
			// Past a limit (or with no value to go by): onto the limits.
			for (int j : limitIndex) {
				normals.add(gs[j]);
				wanted.add(aim[j] - at.score.slack[j]);
				limitAim.add(aim[j]);
			}
			move = onto(normals, wanted);
		} else {
			// The model's lowest point along the limits it is at, and the box's sides it would leave.
			// Which limits: those the step would cross (a step along one limit may cross another
			// it is near, though the way down did not), less those it is better off leaving
			// (where the value's slope is not held back by the limit, its Lagrange multiplier is
			// negative: moving off it, into the limits, helps).
			List<double[]> sides = new ArrayList<>();
			List<Double> sideWanted = new ArrayList<>();
			move = new double[n];
			for (int round = 0; round <= 2 * (n + m); round++) {
				List<double[]> limitNormals = new ArrayList<>();
				for (int j : limitIndex) {
					limitNormals.add(gs[j]);
				}
				double[] lambda = limitNormals.size() > 1 ? multipliers(limitNormals, g) : null;
				int leave = -1;
				for (int k = 0; lambda != null && k < lambda.length; k++) {
					if (lambda[k] < 0 && (leave < 0 || lambda[k] < lambda[leave])) {
						leave = k;
					}
				}
				if (leave >= 0) {
					limitIndex.remove(leave);
					continue;
				}
				normals.clear();
				wanted.clear();
				for (int j : limitIndex) {
					normals.add(gs[j]);
					wanted.add(aim[j] - at.score.slack[j]);
				}
				normals.addAll(sides);
				wanted.addAll(sideWanted);
				double[] d = lowest(g, h, normals, onto(normals, wanted), radius, curvatures ? 0 : step);
				move = d;
				boolean more = false;
				for (int j = 0; j < m; j++) {
					if (near[j] && !limitIndex.contains(j) && at.score.slack[j] + dot(gs[j], d) < aim[j]) {
						limitIndex.add(j);
						more = true;
						break;
					}
				}
				// A step past a side of the box stops on it (rather than being cut short there
				// afterwards, which would make it another step than the one worked out).
				for (int i = 0; !more && i < n; i++) {
					if (at.u[i] + d[i] < -1e-12 || at.u[i] + d[i] > 1 + 1e-12) {
						sides.add(axis(i, 1));
						sideWanted.add(at.u[i] + d[i] < 0 ? -at.u[i] : 1 - at.u[i]);
						more = true;
					}
				}
				if (!more) {
					break;
				}
			}
			for (int j : limitIndex) {
				limitAim.add(aim[j]);
			}
		}
		int limits = limitIndex.size();
		limitSlopes = new ArrayList<>();
		for (int j : limitIndex) {
			limitSlopes.add(gs[j]);
		}
		if (limits == 0 && past) {
			return null;
		}
		double size = norm(move);
		if (size < 1e-9) {
			return null;
		}
		if (size > radius) {
			for (int i = 0; i < n; i++) {
				move[i] *= radius / size;
			}
		}
		predicted = curvatures && !past ? dot(g, move) + dot(move, times(h, move)) / 2 : Double.NaN;
		return move;
	}

	/**
	 * How much each limit holds the value back (minimising it, with each slack at least 0): the
	 * least-squares multipliers in g = sum of multiplier times limit slope; null if they cannot be
	 * told apart.
	 */
	private static double[] multipliers(List<double[]> normals, double[] g) {
		int k = normals.size();
		double[][] a = new double[k][k];
		double[] r = new double[k];
		for (int i = 0; i < k; i++) {
			for (int j = 0; j < k; j++) {
				a[i][j] = dot(normals.get(i), normals.get(j));
			}
			a[i][i] *= 1 + 1e-10;
			r[i] = dot(normals.get(i), g);
		}
		return solve(a, r);
	}

	/** The shortest step meeting each normal's wanted change (least squares where they cannot all be met). */
	private double[] onto(List<double[]> normals, List<Double> wanted) {
		int k = normals.size();
		double[] d = new double[n];
		if (k == 0) {
			return d;
		}
		double[][] a = new double[k][k];
		double[] r = new double[k];
		for (int i = 0; i < k; i++) {
			for (int j = 0; j < k; j++) {
				a[i][j] = dot(normals.get(i), normals.get(j));
			}
			a[i][i] *= 1 + 1e-10;
			r[i] = wanted.get(i);
		}
		double[] lambda = solve(a, r);
		if (lambda == null) {
			return d;
		}
		for (int i = 0; i < k; i++) {
			for (int c = 0; c < n; c++) {
				d[c] += lambda[i] * normals.get(i)[c];
			}
		}
		return d;
	}

	/**
	 * The lowest point of value(d) = g.d + d.H.d / 2 over d = d0 + z, z square to the normals, within
	 * `radius` of no step (Levenberg and Marquardt: H plus a multiple of the identity, as large as
	 * that needs). With `plain` > 0 (no curvatures known), a step of that length down the slope.
	 */
	private double[] lowest(double[] g, double[][] h, List<double[]> normals, double[] d0, double radius, double plain) {
		// A basis of the directions square to the normals.
		List<double[]> basis = new ArrayList<>();
		List<double[]> free = new ArrayList<>();
		for (int pass = 0; pass < 2; pass++) {
			List<double[]> from = new ArrayList<>();
			if (pass == 0) {
				from.addAll(normals);
			} else {
				for (int i = 0; i < n; i++) {
					from.add(axis(i, 1));
				}
			}
			for (double[] v : from) {
				double[] q = v.clone();
				for (double[] b : basis) {
					double c = dot(q, b);
					for (int i = 0; i < n; i++) {
						q[i] -= c * b[i];
					}
				}
				double len = norm(q);
				if (len > 1e-9) {
					for (int i = 0; i < n; i++) {
						q[i] /= len;
					}
					basis.add(q);
					if (pass == 1) {
						free.add(q);
					}
				}
			}
		}
		int r = free.size();
		if (r == 0) {
			return d0.clone();
		}
		// The reduced slope (at d0) and curvature.
		double[] hd0 = times(h, d0);
		double[] gz = new double[r];
		double[][] hz = new double[r][r];
		for (int a = 0; a < r; a++) {
			double[] za = free.get(a);
			for (int i = 0; i < n; i++) {
				gz[a] += za[i] * (g[i] + hd0[i]);
			}
			double[] hza = times(h, za);
			for (int b = 0; b < r; b++) {
				hz[b][a] = dot(free.get(b), hza);
			}
		}
		double[] z;
		if (plain > 0) {
			double len = norm(gz);
			if (len < 1e-15) {
				return d0.clone();
			}
			z = new double[r];
			for (int a = 0; a < r; a++) {
				z[a] = -gz[a] / len * plain;
			}
		} else {
			double scale = 0;
			for (int a = 0; a < r; a++) {
				scale = Math.max(scale, Math.abs(hz[a][a]));
			}
			scale = Math.max(scale, norm(gz) / radius);
			z = null;
			for (double lambda = 0; lambda <= 1e12 * scale + 1; lambda = lambda == 0 ? 1e-6 * scale + 1e-300 : lambda * 4) {
				double[][] a = new double[r][r];
				for (int i = 0; i < r; i++) {
					a[i] = hz[i].clone();
					a[i][i] += lambda;
				}
				double[] minusG = new double[r];
				for (int i = 0; i < r; i++) {
					minusG[i] = -gz[i];
				}
				double[] y = cholesky(a, minusG);
				if (y != null && norm(y) <= radius) {
					z = y;
					break;
				}
			}
			if (z == null) {
				return d0.clone();
			}
		}
		double[] d = d0.clone();
		for (int a = 0; a < r; a++) {
			for (int i = 0; i < n; i++) {
				d[i] += z[a] * free.get(a)[i];
			}
		}
		return d;
	}

	/**
	 * Fits value = c + g.d + d.H.d / 2 (d from `at`) to the tries within `radius` of it, nearer ones
	 * weighing more: {g, H's rows}, or null with too few tries there.
	 */
	private double[][] quadratic(Point at, double radius) {
		int p = 1 + n + n * (n + 1) / 2;
		double unit = radius / 4;
		List<double[]> rows = new ArrayList<>();
		List<Double> values = new ArrayList<>(), weights = new ArrayList<>();
		for (Point q : order) {
			if (Double.isNaN(q.score.value) || q.score.failed()) {
				continue;
			}
			// In units of a quarter of the radius, so that every term is of a size.
			double[] d = new double[n];
			double far = 0;
			for (int i = 0; i < n; i++) {
				d[i] = (q.u[i] - at.u[i]) / unit;
				far = Math.max(far, Math.abs(d[i]));
			}
			if (far > 4) {
				continue;
			}
			double[] row = new double[p];
			int k = 0;
			row[k++] = 1;
			for (int i = 0; i < n; i++) {
				row[k++] = d[i];
			}
			for (int i = 0; i < n; i++) {
				for (int j = i; j < n; j++) {
					row[k++] = i == j ? d[i] * d[i] / 2 : d[i] * d[j];
				}
			}
			rows.add(row);
			values.add(q.score.value - at.score.value);
			double dd = norm(d);
			weights.add(1 / (1 + dd * dd));
		}
		if (rows.size() < 2 * n + 1) {
			return null;
		}
		double[][] a = new double[p][p];
		double[] b = new double[p];
		for (int k = 0; k < rows.size(); k++) {
			double[] row = rows.get(k);
			double w = weights.get(k);
			for (int i = 0; i < p; i++) {
				b[i] += w * row[i] * values.get(k);
				for (int j = 0; j < p; j++) {
					a[i][j] += w * row[i] * row[j];
				}
			}
		}
		// A ridge, so that terms the tries say little or nothing about (how two variables interact,
		// with fewer tries than terms) come out as none, as in Powell's least-change models.
		double trace = 0;
		for (int i = 0; i < p; i++) {
			trace += a[i][i];
		}
		for (int i = 1; i < p; i++) {
			a[i][i] += (i <= n ? 1e-9 : 1e-4) * trace / p;
		}
		double[] c = solve(a, b);
		if (c == null) {
			return null;
		}
		double[][] out = new double[n + 1][n];
		int k = 1;
		for (int i = 0; i < n; i++) {
			out[0][i] = c[k++] / unit;
		}
		for (int i = 0; i < n; i++) {
			for (int j = i; j < n; j++) {
				out[i + 1][j] = c[k] / (unit * unit);
				out[j + 1][i] = c[k] / (unit * unit);
				k++;
			}
		}
		return out;
	}

	private double[] times(double[][] h, double[] v) {
		double[] out = new double[n];
		for (int i = 0; i < n; i++) {
			out[i] = dot(h[i], v);
		}
		return out;
	}

	/** Solves a x = b (Gaussian elimination, partial pivoting); null if singular. */
	static double[] solve(double[][] a0, double[] b0) {
		int k = b0.length;
		double[][] a = new double[k][];
		for (int i = 0; i < k; i++) {
			a[i] = a0[i].clone();
		}
		double[] b = b0.clone();
		for (int c = 0; c < k; c++) {
			int piv = c;
			for (int r = c + 1; r < k; r++) {
				if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) {
					piv = r;
				}
			}
			if (Math.abs(a[piv][c]) < 1e-300) {
				return null;
			}
			double[] t = a[c];
			a[c] = a[piv];
			a[piv] = t;
			double tb = b[c];
			b[c] = b[piv];
			b[piv] = tb;
			for (int r = c + 1; r < k; r++) {
				double f = a[r][c] / a[c][c];
				for (int j = c; j < k; j++) {
					a[r][j] -= f * a[c][j];
				}
				b[r] -= f * b[c];
			}
		}
		double[] x = new double[k];
		for (int r = k - 1; r >= 0; r--) {
			double s = b[r];
			for (int j = r + 1; j < k; j++) {
				s -= a[r][j] * x[j];
			}
			x[r] = s / a[r][r];
		}
		for (double v : x) {
			if (Double.isNaN(v) || Double.isInfinite(v)) {
				return null;
			}
		}
		return x;
	}

	/** Solves a x = b for a symmetric positive definite a; null if it is not. */
	private static double[] cholesky(double[][] a, double[] b) {
		int k = b.length;
		double[][] l = new double[k][k];
		for (int i = 0; i < k; i++) {
			for (int j = 0; j <= i; j++) {
				double s = a[i][j];
				for (int t = 0; t < j; t++) {
					s -= l[i][t] * l[j][t];
				}
				if (i == j) {
					if (!(s > 0)) {
						return null;
					}
					l[i][i] = Math.sqrt(s);
				} else {
					l[i][j] = s / l[j][j];
				}
			}
		}
		double[] y = new double[k];
		for (int i = 0; i < k; i++) {
			double s = b[i];
			for (int t = 0; t < i; t++) {
				s -= l[i][t] * y[t];
			}
			y[i] = s / l[i][i];
		}
		double[] x = new double[k];
		for (int i = k - 1; i >= 0; i--) {
			double s = y[i];
			for (int t = i + 1; t < k; t++) {
				s -= l[t][i] * x[t];
			}
			x[i] = s / l[i][i];
		}
		return x;
	}

	/** Tries u, once; null when out of tries or stopped. */
	private Point evaluate(double[] u) throws InterruptedException {
		String key = Arrays.toString(u);
		Point known = tried.get(key);
		if (known != null) {
			return known;
		}
		if (order.size() >= settings.budget) {
			return null;
		}
		if (monitor.stop()) {
			stopped = true;
			return null;
		}
		Point p = new Point(u.clone(), problem.evaluate(u.clone()));
		tried.put(key, p);
		order.add(p);
		if (best == null || better(p.score, best.score)) {
			best = p;
		}
		return p;
	}

	private double[] axis(int i, double sign) {
		double[] d = new double[n];
		d[i] = sign;
		return d;
	}

	private static boolean same(double[] a, double[] b) {
		for (int i = 0; i < a.length; i++) {
			if (Math.abs(a[i] - b[i]) > 1e-12) {
				return false;
			}
		}
		return true;
	}

	static double distance(double[] a, double[] b) {
		double s = 0;
		for (int i = 0; i < a.length; i++) {
			s += (a[i] - b[i]) * (a[i] - b[i]);
		}
		return Math.sqrt(s / Math.max(1, a.length));
	}

	private static double dot(double[] a, double[] b) {
		double s = 0;
		for (int i = 0; i < a.length; i++) {
			s += a[i] * b[i];
		}
		return s;
	}

	private static double norm(double[] a) {
		return Math.sqrt(dot(a, a));
	}

	private static double clamp(double v) {
		return Math.max(0, Math.min(1, v));
	}
}
