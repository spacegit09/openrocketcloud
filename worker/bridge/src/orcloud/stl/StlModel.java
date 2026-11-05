package orcloud.stl;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/**
 * A 3D model read from an STL file (binary or ASCII), reduced to what mass and balance need: the
 * enclosed volume, the surface area, the centroid of each, and the bounding box, all in the file's
 * own units and axes (STL records neither units nor orientation). The file is read in one pass
 * without keeping its triangles, so large models need little memory.
 *
 * Volume and its centroid come from the signed tetrahedra each triangle forms with a reference
 * point; they are exact for a closed (watertight) mesh with consistently oriented triangles, and
 * the sign of the result absorbs inside-out meshes. Whether the mesh is closed is judged from its
 * vector area, which is zero for a closed surface.
 */
public final class StlModel {
	public final int triangles;
	/** Enclosed volume (file units cubed); meaningful only when {@link #closed}. */
	public final double volume;
	public final double area;
	public final double[] volumeCentroid;
	public final double[] areaCentroid;
	public final double[] min;
	public final double[] max;
	public final boolean closed;

	private StlModel(Accumulator a) {
		this.triangles = a.count;
		this.volume = Math.abs(a.volume);
		this.area = a.area;
		double[] vc = new double[3];
		double[] ac = new double[3];
		for (int i = 0; i < 3; i++) {
			vc[i] = a.volume != 0 ? a.ref[i] + a.volumeMoment[i] / a.volume : a.ref[i];
			ac[i] = a.area > 0 ? a.ref[i] + a.areaMoment[i] / a.area : a.ref[i];
		}
		this.volumeCentroid = vc;
		this.areaCentroid = ac;
		this.min = a.min;
		this.max = a.max;
		double open = Math.sqrt(a.vectorArea[0] * a.vectorArea[0] + a.vectorArea[1] * a.vectorArea[1] + a.vectorArea[2] * a.vectorArea[2]);
		this.closed = a.area > 0 && open <= 1e-4 * a.area && Math.abs(a.volume) > 0;
	}

	public double size(int axis) {
		return max[axis] - min[axis];
	}

	/** Reads binary or ASCII STL. */
	public static StlModel read(byte[] data) throws IOException {
		Accumulator acc = new Accumulator();
		if (isBinary(data)) {
			ByteBuffer b = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
			long count = Integer.toUnsignedLong(b.getInt(80));
			double[] v = new double[9];
			for (long t = 0; t < count; t++) {
				int off = (int) (84 + t * 50 + 12); // skip the facet normal: it is recomputed
				for (int i = 0; i < 9; i++) {
					v[i] = b.getFloat(off + 4 * i);
				}
				acc.add(v);
			}
		} else {
			readAscii(data, acc);
		}
		if (acc.count == 0) {
			throw new IOException("The file contains no triangles.");
		}
		return new StlModel(acc);
	}

	private static boolean isBinary(byte[] data) throws IOException {
		if (data.length >= 84) {
			long count = Integer.toUnsignedLong(ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN).getInt(80));
			if (84 + 50 * count == data.length) {
				return true;
			}
		}
		int i = 0;
		while (i < data.length && Character.isWhitespace(data[i])) {
			i++;
		}
		if (i + 5 <= data.length && new String(data, i, 5, StandardCharsets.US_ASCII).equalsIgnoreCase("solid")) {
			return false;
		}
		if (data.length >= 84) {
			long count = Integer.toUnsignedLong(ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN).getInt(80));
			if (84 + 50 * count <= data.length) {
				return true; // binary with trailing bytes
			}
		}
		throw new IOException("This is not an STL file.");
	}

	private static void readAscii(byte[] data, Accumulator acc) throws IOException {
		double[] v = new double[9];
		int n = 0;
		int i = 0;
		int len = data.length;
		while (i < len) {
			// Find the next "vertex" keyword.
			while (i < len && (data[i] | 0x20) != 'v') {
				i++;
			}
			if (i + 6 > len) {
				break;
			}
			if (!new String(data, i, 6, StandardCharsets.US_ASCII).equalsIgnoreCase("vertex")) {
				i++;
				continue;
			}
			i += 6;
			for (int k = 0; k < 3; k++) {
				while (i < len && Character.isWhitespace(data[i])) {
					i++;
				}
				int start = i;
				while (i < len && !Character.isWhitespace(data[i])) {
					i++;
				}
				try {
					v[n * 3 + k] = Double.parseDouble(new String(data, start, i - start, StandardCharsets.US_ASCII));
				} catch (NumberFormatException e) {
					throw new IOException("Unreadable number in the STL file.");
				}
			}
			if (++n == 3) {
				acc.add(v);
				n = 0;
			}
		}
	}

	/** Running sums, relative to the first vertex for numerical precision. */
	private static final class Accumulator {
		int count;
		double[] ref;
		double volume;
		double area;
		final double[] volumeMoment = new double[3];
		final double[] areaMoment = new double[3];
		final double[] vectorArea = new double[3];
		final double[] min = { Double.MAX_VALUE, Double.MAX_VALUE, Double.MAX_VALUE };
		final double[] max = { -Double.MAX_VALUE, -Double.MAX_VALUE, -Double.MAX_VALUE };

		void add(double[] v) {
			if (ref == null) {
				ref = new double[] { v[0], v[1], v[2] };
			}
			for (int i = 0; i < 9; i++) {
				min[i % 3] = Math.min(min[i % 3], v[i]);
				max[i % 3] = Math.max(max[i % 3], v[i]);
			}
			double ax = v[0] - ref[0], ay = v[1] - ref[1], az = v[2] - ref[2];
			double bx = v[3] - ref[0], by = v[4] - ref[1], bz = v[5] - ref[2];
			double cx = v[6] - ref[0], cy = v[7] - ref[1], cz = v[8] - ref[2];
			// Signed volume of the tetrahedron (ref, a, b, c), and its centroid's moment.
			double vol = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
			volume += vol;
			volumeMoment[0] += vol * (ax + bx + cx) / 4;
			volumeMoment[1] += vol * (ay + by + cy) / 4;
			volumeMoment[2] += vol * (az + bz + cz) / 4;
			// Triangle area (half the cross product of two edges) and its centroid's moment.
			double ux = bx - ax, uy = by - ay, uz = bz - az;
			double wx = cx - ax, wy = cy - ay, wz = cz - az;
			double nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
			double a = Math.sqrt(nx * nx + ny * ny + nz * nz) / 2;
			area += a;
			areaMoment[0] += a * (ax + bx + cx) / 3;
			areaMoment[1] += a * (ay + by + cy) / 3;
			areaMoment[2] += a * (az + bz + cz) / 3;
			vectorArea[0] += nx / 2;
			vectorArea[1] += ny / 2;
			vectorArea[2] += nz / 2;
			count++;
		}
	}
}
