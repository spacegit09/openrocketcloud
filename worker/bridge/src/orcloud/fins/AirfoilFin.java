package orcloud.fins;

import java.util.ArrayList;
import java.util.List;

import info.openrocket.core.util.Coordinate;

/**
 * A fin as a solid with its cross section ({@link FinProfile}), for 3D export: in the fin's own
 * frame, as OpenRocket draws fins (x along the root from its leading edge, y outward from the
 * body, z through the thickness, centred).
 *
 * The outline is cut at each of its corners' heights (and in between, at most an eighth of the
 * height apart); at each height the chord runs between the leading and trailing edges there, and
 * the profile is laid across it. Upper and lower surfaces join the heights, and flat caps close
 * the root and a blunt tip. An outline that crosses some height more than twice (a notched
 * freeform fin) has no single chord there: {@link #build} gives null and the fin stays flat.
 */
public final class AirfoilFin {
	/** Vertices (x, y, z), normals (x, y, z) and triangles: for each, 3 vertex and 3 normal indices. */
	public final List<double[]> vertices = new ArrayList<>();
	public final List<double[]> normals = new ArrayList<>();
	public final List<int[]> triangles = new ArrayList<>(); // { v0, v1, v2, n0, n1, n2 }

	private AirfoilFin() {
	}

	/**
	 * The fin with outline `points` (closed, as FinSet.getFinPointsWithRoot gives them), thickness
	 * (m) and profile, with about `n` points along each chord; or null if the outline has no single
	 * chord at some height.
	 */
	public static AirfoilFin build(Coordinate[] points, double thickness, FinProfile profile, int n) {
		List<double[]> outline = new ArrayList<>();
		for (Coordinate c : points) {
			double[] p = { c.x, c.y };
			if (outline.isEmpty() || !same(outline.get(outline.size() - 1), p)) {
				outline.add(p);
			}
		}
		if (outline.size() > 1 && same(outline.get(0), outline.get(outline.size() - 1))) {
			outline.remove(outline.size() - 1);
		}
		if (outline.size() < 3 || !(thickness > 0)) {
			return null;
		}
		double low = Double.MAX_VALUE, high = -Double.MAX_VALUE;
		for (double[] p : outline) {
			low = Math.min(low, p[1]);
			high = Math.max(high, p[1]);
		}
		double height = high - low;
		if (!(height > 1e-9)) {
			return null;
		}

		// The heights: every corner's, and more where they are far apart.
		List<Double> ys = new ArrayList<>();
		for (double[] p : outline) {
			ys.add(p[1]);
		}
		ys.sort(Double::compare);
		List<Double> heights = new ArrayList<>();
		for (double y : ys) {
			if (heights.isEmpty() || y - heights.get(heights.size() - 1) > height * 1e-6) {
				if (!heights.isEmpty()) {
					double prev = heights.get(heights.size() - 1);
					int extra = (int) Math.ceil((y - prev) / (height / 8)) - 1;
					for (int k = 1; k <= extra; k++) {
						heights.add(prev + (y - prev) * k / (extra + 1));
					}
				}
				heights.add(y);
			}
		}
		int rows = heights.size();
		double[] lead = new double[rows], trail = new double[rows];
		for (int j = 0; j < rows; j++) {
			double y = Math.max(low + height * 1e-7, Math.min(high - height * 1e-7, heights.get(j)));
			List<Double> cross = new ArrayList<>();
			for (int i = 0; i < outline.size(); i++) {
				double[] a = outline.get(i), b = outline.get((i + 1) % outline.size());
				if ((a[1] <= y && y < b[1]) || (b[1] <= y && y < a[1])) {
					cross.add(a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]));
				}
			}
			if (cross.size() != 2) {
				return null;
			}
			lead[j] = Math.min(cross.get(0), cross.get(1));
			trail[j] = Math.max(cross.get(0), cross.get(1));
		}
		double rootChord = trail[0] - lead[0];
		if (!(rootChord > 1e-9)) {
			return null;
		}

		AirfoilFin fin = new AirfoilFin();
		// Per height, the columns of points along the chord: a corner twice (each side keeps its own
		// normal there), at one vertex all the same; and where the profile closes (its edges) the
		// upper and lower surfaces share the vertex, so the solid is closed.
		int[][][] pos = null; // [surface 0 upper, 1 lower][height][column] -> vertex
		int[] cols = null;
		for (int j = 0; j < rows; j++) {
			double chord = trail[j] - lead[j];
			double t = Math.min(profile.scaled ? thickness * chord / rootChord : thickness, Math.max(chord, 0));
			FinProfile.Stations st = profile.stations(n, chord, t);
			if (cols == null) {
				List<Integer> c = new ArrayList<>();
				for (int i = 0; i < st.s.length; i++) {
					c.add(i);
					if (st.kink[i] && i > 0 && i < st.s.length - 1) {
						c.add(i);
					}
				}
				cols = c.stream().mapToInt(Integer::intValue).toArray();
				pos = new int[2][rows][cols.length];
			}
			for (int k = 0; k < cols.length; k++) {
				if (k > 0 && cols[k] == cols[k - 1]) {
					pos[0][j][k] = pos[0][j][k - 1];
					pos[1][j][k] = pos[1][j][k - 1];
					continue;
				}
				double s = st.s[cols[k]];
				double x = lead[j] + s * chord;
				double h = profile.half(s, chord, t);
				pos[0][j][k] = fin.vertex(x, heights.get(j), h);
				pos[1][j][k] = h > thickness * 1e-9 ? fin.vertex(x, heights.get(j), -h) : pos[0][j][k];
			}
		}

		// Surfaces: two triangles per cell, with each corner's normal averaged over the faces of its
		// surface that share its column side.
		double[][][][] acc = new double[2][rows][cols.length][3];
		List<int[]> faces = new ArrayList<>(); // { surface, j0, k0, j1, k1, j2, k2 }
		for (int j = 0; j + 1 < rows; j++) {
			for (int k = 0; k + 1 < cols.length; k++) {
				if (cols[k] == cols[k + 1]) {
					continue; // the two sides of a corner
				}
				faces.add(new int[] { 0, j, k, j, k + 1, j + 1, k + 1 });
				faces.add(new int[] { 0, j, k, j + 1, k + 1, j + 1, k });
				faces.add(new int[] { 1, j, k, j + 1, k + 1, j, k + 1 });
				faces.add(new int[] { 1, j, k, j + 1, k, j + 1, k + 1 });
			}
		}
		List<int[]> kept = new ArrayList<>();
		for (int[] f : faces) {
			int sf = f[0];
			int a = pos[sf][f[1]][f[2]], b = pos[sf][f[3]][f[4]], c = pos[sf][f[5]][f[6]];
			if (a == b || b == c || a == c) {
				continue; // where the edge comes to a point
			}
			double[] x = fin.cross(a, b, c);
			for (int q = 1; q < 7; q += 2) {
				double[] m = acc[sf][f[q]][f[q + 1]];
				m[0] += x[0];
				m[1] += x[1];
				m[2] += x[2];
			}
			kept.add(f);
		}
		int[][][] nrm = new int[2][rows][cols.length];
		for (int sf = 0; sf < 2; sf++) {
			for (int j = 0; j < rows; j++) {
				for (int k = 0; k < cols.length; k++) {
					double[] m = acc[sf][j][k];
					double len = Math.sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2]);
					nrm[sf][j][k] = len > 1e-30 ? fin.normal(new double[] { m[0] / len, m[1] / len, m[2] / len }) : -1;
				}
			}
		}
		int up = fin.normal(new double[] { 0, 0, 1 }), down = fin.normal(new double[] { 0, 0, -1 });
		for (int[] f : kept) {
			int sf = f[0];
			int[] t = new int[6];
			for (int q = 0; q < 3; q++) {
				int j = f[1 + 2 * q], k = f[2 + 2 * q];
				t[q] = pos[sf][j][k];
				t[3 + q] = nrm[sf][j][k] >= 0 ? nrm[sf][j][k] : sf == 0 ? up : down;
			}
			fin.triangles.add(t);
		}

		// Caps: the root and the tip (for a pointed tip, a sliver that keeps the solid closed).
		fin.cap(pos[0][0], pos[1][0], cols, new double[] { 0, -1, 0 });
		fin.cap(pos[0][rows - 1], pos[1][rows - 1], cols, new double[] { 0, 1, 0 });
		return fin;
	}

	/** A flat cap across one height, between its upper and lower points, facing `out`. */
	private void cap(int[] up, int[] low, int[] cols, double[] out) {
		int n = normal(out);
		for (int k = 0; k + 1 < cols.length; k++) {
			if (cols[k] == cols[k + 1]) {
				continue;
			}
			triangle(up[k], up[k + 1], low[k + 1], n, out);
			triangle(up[k], low[k + 1], low[k], n, out);
		}
	}

	/** A triangle facing `out` (its winding turned if need be), with one normal; none if it has no area. */
	private void triangle(int a, int b, int c, int n, double[] out) {
		if (a == b || b == c || a == c) {
			return;
		}
		double[] x = cross(a, b, c);
		if (x[0] * out[0] + x[1] * out[1] + x[2] * out[2] < 0) {
			int t = b;
			b = c;
			c = t;
		}
		triangles.add(new int[] { a, b, c, n, n, n });
	}

	private double[] cross(int a, int b, int c) {
		double[] p = vertices.get(a), q = vertices.get(b), r = vertices.get(c);
		double ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
		double vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
		return new double[] { uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx };
	}

	private int vertex(double x, double y, double z) {
		vertices.add(new double[] { x, y, z });
		return vertices.size() - 1;
	}

	private int normal(double[] n) {
		normals.add(n);
		return normals.size() - 1;
	}

	private static boolean same(double[] a, double[] b) {
		return Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12;
	}

	/** The solid's volume (m³), from its triangles (for checks). */
	public double volume() {
		double v = 0;
		for (int[] t : triangles) {
			double[] p = vertices.get(t[0]), q = vertices.get(t[1]), r = vertices.get(t[2]);
			v += (p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0])) / 6;
		}
		return v;
	}
}
