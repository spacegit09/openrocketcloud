package orcloud.view3d;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import de.javagl.obj.FloatTuple;
import de.javagl.obj.ObjFace;
import info.openrocket.core.file.wavefrontobj.Axis;
import info.openrocket.core.file.wavefrontobj.CoordTransform;
import info.openrocket.core.file.wavefrontobj.DefaultObj;
import info.openrocket.core.file.wavefrontobj.ObjUtils.LevelOfDetail;
import info.openrocket.core.file.wavefrontobj.export.components.BodyTubeExporter;
import info.openrocket.core.file.wavefrontobj.export.components.FinSetExporter;
import info.openrocket.core.file.wavefrontobj.export.components.LaunchLugExporter;
import info.openrocket.core.file.wavefrontobj.export.components.MassObjectExporter;
import info.openrocket.core.file.wavefrontobj.export.components.MotorExporter;
import info.openrocket.core.file.wavefrontobj.export.components.RailButtonExporter;
import info.openrocket.core.file.wavefrontobj.export.components.RingComponentExporter;
import info.openrocket.core.file.wavefrontobj.export.components.RocketComponentExporter;
import info.openrocket.core.file.wavefrontobj.export.components.TransitionExporter;
import info.openrocket.core.file.wavefrontobj.export.components.TubeFinSetExporter;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.motor.Motor;
import info.openrocket.core.motor.MotorConfiguration;
import info.openrocket.core.rocketcomponent.BodyTube;
import info.openrocket.core.rocketcomponent.ComponentAssembly;
import info.openrocket.core.rocketcomponent.FinSet;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.InstanceContext;
import info.openrocket.core.rocketcomponent.LaunchLug;
import info.openrocket.core.rocketcomponent.MassComponent;
import info.openrocket.core.rocketcomponent.MassObject;
import info.openrocket.core.rocketcomponent.MotorMount;
import info.openrocket.core.rocketcomponent.RailButton;
import info.openrocket.core.rocketcomponent.RingComponent;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.rocketcomponent.SymmetricComponent;
import info.openrocket.core.rocketcomponent.Transition;
import info.openrocket.core.rocketcomponent.TubeFinSet;
import info.openrocket.core.util.BoundingBox;
import info.openrocket.core.util.Coordinate;
import orcloud.stl.PartMesh;
import orcloud.stl.PartMeshes;

/**
 * The rocket of a flight configuration as polygon meshes, for the browser's 3D view. OpenRocket's
 * own 3D view draws with OpenGL through native libraries a browser does not have; these meshes come
 * from OpenRocket's OBJ exporters (its "Export as 3D file" feature) instead, so every part keeps
 * OpenRocket's own shapes, fin counts, cant, clusters, pods and motor positions.
 *
 * Coordinates are OpenRocket's with z negated, which makes them right-handed as WebGL expects:
 * x runs from the nose tip aft, y up. Each component's faces are split into its outside, inside and
 * edge (end) surfaces, which OpenRocket's 3D view colours separately.
 */
public final class RocketMesh {
	public static final int OUTSIDE = 0, INSIDE = 1, EDGE = 2;
	/** Floats per face vertex: position, normal (NaN when the exporter gave none), texture u, v. */
	public static final int STRIDE = 8;

	/** The faces of one component (or one motor) on one kind of surface. */
	public static final class Part {
		/** The component, or for a motor its motor mount. */
		public final RocketComponent component;
		/** The motor, or null for a component. */
		public final Motor motor;
		public final int surface;
		/** Whether this is an imported 3D model's own shape (see {@link PartMeshes}). */
		public final boolean model;
		/** Faces [firstFace, firstFace + faceCount) and their vertices from firstVertex on. */
		public final int firstFace, faceCount, firstVertex, vertexCount;

		Part(RocketComponent component, Motor motor, int surface, boolean model, int firstFace, int faceCount, int firstVertex,
				int vertexCount) {
			this.component = component;
			this.motor = motor;
			this.surface = surface;
			this.model = model;
			this.firstFace = firstFace;
			this.faceCount = faceCount;
			this.firstVertex = firstVertex;
			this.vertexCount = vertexCount;
		}
	}

	public final List<Part> parts = new ArrayList<>();
	/** STRIDE floats per face vertex, in face order. */
	public float[] vertices = new float[1 << 14];
	public int vertexCount;
	/** The number of vertices of each face. */
	public int[] faceSizes = new int[1 << 11];
	public int faceCount;
	/** The configuration's extent, in OpenRocket coordinates. */
	public BoundingBox bounds;
	/** Components OpenRocket could not export, with the reason. */
	public final List<String> problems = new ArrayList<>();

	private static final CoordTransform TRANSFORM = CoordTransform.generateUsingAxialAndForwardAxes(Axis.X_MIN, Axis.Y, 0, 0, 0);

	/** The meshes of the active, visible components of `config`. */
	public static RocketMesh of(FlightConfiguration config, LevelOfDetail lod) {
		RocketMesh m = new RocketMesh();
		WarningSet warnings = new WarningSet();
		for (RocketComponent c : config.getRocket()) {
			if (c instanceof ComponentAssembly || !config.isComponentActive(c) || !c.isVisible()) {
				continue;
			}
			List<InstanceContext> instances = config.getActiveInstances().getInstanceContexts(c);
			if (instances == null || instances.isEmpty()) {
				continue;
			}
			try {
				PartMesh model = PartMeshes.get(c);
				if (model != null) {
					m.addModel((MassComponent) c, model, instances);
					continue;
				}
				DefaultObj obj = new DefaultObj();
				RocketComponentExporter<?> exporter = exporter(obj, config, c, lod, warnings);
				if (exporter == null) {
					continue;
				}
				exporter.addToObj();
				m.add(obj, c, null, hasInside(c) ? instances : null);
				if (c instanceof MotorMount && ((MotorMount) c).isMotorMount()) {
					MotorConfiguration mc = ((MotorMount) c).getMotorConfig(config.getId());
					Motor motor = mc == null ? null : mc.getMotor();
					if (motor != null) {
						DefaultObj motorObj = new DefaultObj();
						new MotorExporter(motorObj, config, TRANSFORM, c, "motor", lod, true, warnings).addToObj();
						m.add(motorObj, c, motor, null);
					}
				}
			} catch (RuntimeException e) {
				m.problems.add(c.getName() + ": " + e);
			}
		}
		m.bounds = config.getBoundingBox();
		return m;
	}

	/** OpenRocket's exporter for the component (OBJExporterFactory's choice), or null for none. */
	private static RocketComponentExporter<?> exporter(DefaultObj obj, FlightConfiguration config, RocketComponent c,
			LevelOfDetail lod, WarningSet w) {
		String g = "part";
		if (c instanceof BodyTube) {
			return new BodyTubeExporter(obj, config, TRANSFORM, (BodyTube) c, g, lod, true, w);
		} else if (c instanceof Transition) {
			return new TransitionExporter(obj, config, TRANSFORM, (Transition) c, g, lod, true, w);
		} else if (c instanceof LaunchLug) {
			return new LaunchLugExporter(obj, config, TRANSFORM, (LaunchLug) c, g, lod, true, w);
		} else if (c instanceof TubeFinSet) {
			return new TubeFinSetExporter(obj, config, TRANSFORM, (TubeFinSet) c, g, lod, true, w);
		} else if (c instanceof FinSet) {
			return new FinSetExporter(obj, config, TRANSFORM, (FinSet) c, g, lod, true, w);
		} else if (c instanceof RingComponent) {
			return new RingComponentExporter(obj, config, TRANSFORM, (RingComponent) c, g, lod, true, w);
		} else if (c instanceof MassObject) {
			return new MassObjectExporter(obj, config, TRANSFORM, (MassObject) c, g, lod, true, w);
		} else if (c instanceof RailButton) {
			return new RailButtonExporter(obj, config, TRANSFORM, (RailButton) c, g, lod, true, w);
		}
		return null;
	}

	/**
	 * Adds an imported 3D model's shape in place of OpenRocket's cylinder, at each instance of the
	 * component and its radial position, turned by its radial direction and scaled with its length.
	 */
	private void addModel(MassComponent c, PartMesh model, List<InstanceContext> instances) {
		double s = model.length > 0 && c.getLength() > 0 ? c.getLength() / model.length : 1;
		// Off-axis placement, which OpenRocket adds to a mass object's instances itself; the model
		// turns about the rocket's axis with the same angle (the component's radial direction).
		double turn = c.getRadialDirection(), cos = Math.cos(turn), sin = Math.sin(turn);
		double ry = c.getRadialPosition() * cos;
		double rz = c.getRadialPosition() * sin;
		float[] pos = model.positions;
		int[] tri = model.triangles;
		float[] normals = model.cornerNormals();
		int tc = tri.length / 3;
		int firstFace = faceCount, firstVertex = vertexCount;
		for (InstanceContext context : instances) {
			// The instance's transformation as a matrix: origin and the images of the unit axes.
			Coordinate o = context.transform.transform(Coordinate.ZERO);
			Coordinate[] axes = { context.transform.linearTransform(new Coordinate(1, 0, 0)),
					context.transform.linearTransform(new Coordinate(0, 1, 0)), context.transform.linearTransform(new Coordinate(0, 0, 1)) };
			if (faceCount + tc > faceSizes.length) {
				faceSizes = Arrays.copyOf(faceSizes, Math.max(faceSizes.length * 2, faceCount + tc));
			}
			if ((vertexCount + tc * 3) * STRIDE > vertices.length) {
				vertices = Arrays.copyOf(vertices, Math.max(vertices.length * 2, (vertexCount + tc * 3) * STRIDE));
			}
			for (int t = 0; t < tc; t++) {
				faceSizes[faceCount++] = 3;
				for (int k = 0; k < 3; k++) {
					int v = tri[t * 3 + k] * 3;
					double py = pos[v + 1] * s, pz = pos[v + 2] * s;
					double x = pos[v] * s, y = ry + py * cos - pz * sin, z = rz + py * sin + pz * cos;
					int n = t * 9 + k * 3;
					double nx = normals[n], ny = normals[n + 1] * cos - normals[n + 2] * sin, nz = normals[n + 1] * sin + normals[n + 2] * cos;
					int out = vertexCount++ * STRIDE;
					vertices[out] = (float) (o.x + axes[0].x * x + axes[1].x * y + axes[2].x * z);
					vertices[out + 1] = (float) (o.y + axes[0].y * x + axes[1].y * y + axes[2].y * z);
					vertices[out + 2] = (float) -(o.z + axes[0].z * x + axes[1].z * y + axes[2].z * z);
					vertices[out + 3] = (float) (axes[0].x * nx + axes[1].x * ny + axes[2].x * nz);
					vertices[out + 4] = (float) (axes[0].y * nx + axes[1].y * ny + axes[2].y * nz);
					vertices[out + 5] = (float) -(axes[0].z * nx + axes[1].z * ny + axes[2].z * nz);
					vertices[out + 6] = vertices[out + 7] = 0;
				}
			}
		}
		parts.add(new Part(c, null, OUTSIDE, true, firstFace, faceCount - firstFace, firstVertex, vertexCount - firstVertex));
	}

	/** Tubes and shells around their own axis, which have an inside surface. */
	private static boolean hasInside(RocketComponent c) {
		return c instanceof SymmetricComponent || c instanceof RingComponent || c instanceof LaunchLug;
	}

	/**
	 * Adds the exporter's faces, sorted into surfaces. A face is on the inside when its normal points
	 * toward the axis of the nearest instance, and an edge when it faces fore or aft.
	 */
	private void add(DefaultObj obj, RocketComponent c, Motor motor, List<InstanceContext> instances) {
		int n = obj.getNumFaces();
		if (n == 0) {
			return;
		}
		double[][] axes = null;
		if (instances != null) {
			axes = new double[instances.size()][];
			for (int i = 0; i < axes.length; i++) {
				Coordinate o = instances.get(i).transform.transform(Coordinate.ZERO);
				axes[i] = new double[] { o.y, -o.z };
			}
		}
		int[] surface = new int[n];
		int[] count = new int[3];
		for (int f = 0; f < n; f++) {
			surface[f] = axes == null ? OUTSIDE : classify(obj, obj.getFace(f), axes);
			count[surface[f]]++;
		}
		for (int s = 0; s < 3; s++) {
			if (count[s] == 0) {
				continue;
			}
			int firstFace = faceCount, firstVertex = vertexCount;
			for (int f = 0; f < n; f++) {
				if (surface[f] == s) {
					addFace(obj, obj.getFace(f));
				}
			}
			parts.add(new Part(c, motor, s, false, firstFace, faceCount - firstFace, firstVertex, vertexCount - firstVertex));
		}
	}

	private static int classify(DefaultObj obj, ObjFace face, double[][] axes) {
		double cy = 0, cz = 0, nx = 0, ny = 0, nz = 0;
		int k = face.getNumVertices();
		for (int i = 0; i < k; i++) {
			FloatTuple v = obj.getVertex(face.getVertexIndex(i));
			cy += v.getY();
			cz += v.getZ();
		}
		cy /= k;
		cz /= k;
		if (face.containsNormalIndices()) {
			for (int i = 0; i < k; i++) {
				FloatTuple v = obj.getNormal(face.getNormalIndex(i));
				nx += v.getX();
				ny += v.getY();
				nz += v.getZ();
			}
		} else {
			double[] g = newell(obj, face);
			nx = g[0];
			ny = g[1];
			nz = g[2];
		}
		double radial = Math.hypot(ny, nz);
		if (Math.abs(nx) > 2 * radial) {
			return EDGE;
		}
		double[] axis = axes[0];
		double best = Double.MAX_VALUE;
		for (double[] a : axes) {
			double d = Math.hypot(cy - a[0], cz - a[1]);
			if (d < best) {
				best = d;
				axis = a;
			}
		}
		return ny * (cy - axis[0]) + nz * (cz - axis[1]) < 0 ? INSIDE : OUTSIDE;
	}

	/** The face's normal from its winding (Newell's method). */
	static double[] newell(DefaultObj obj, ObjFace face) {
		double x = 0, y = 0, z = 0;
		int k = face.getNumVertices();
		for (int i = 0; i < k; i++) {
			FloatTuple a = obj.getVertex(face.getVertexIndex(i));
			FloatTuple b = obj.getVertex(face.getVertexIndex((i + 1) % k));
			x += (a.getY() - b.getY()) * (a.getZ() + b.getZ());
			y += (a.getZ() - b.getZ()) * (a.getX() + b.getX());
			z += (a.getX() - b.getX()) * (a.getY() + b.getY());
		}
		return new double[] { x, y, z };
	}

	private void addFace(DefaultObj obj, ObjFace face) {
		int k = face.getNumVertices();
		if (faceCount == faceSizes.length) {
			faceSizes = Arrays.copyOf(faceSizes, faceCount * 2);
		}
		faceSizes[faceCount++] = k;
		if ((vertexCount + k) * STRIDE > vertices.length) {
			vertices = Arrays.copyOf(vertices, Math.max(vertices.length * 2, (vertexCount + k) * STRIDE));
		}
		boolean normals = face.containsNormalIndices(), uv = face.containsTexCoordIndices();
		for (int i = 0; i < k; i++) {
			int o = vertexCount++ * STRIDE;
			FloatTuple p = obj.getVertex(face.getVertexIndex(i));
			vertices[o] = p.getX();
			vertices[o + 1] = p.getY();
			vertices[o + 2] = p.getZ();
			if (normals) {
				FloatTuple nv = obj.getNormal(face.getNormalIndex(i));
				vertices[o + 3] = nv.getX();
				vertices[o + 4] = nv.getY();
				vertices[o + 5] = nv.getZ();
			} else {
				vertices[o + 3] = vertices[o + 4] = vertices[o + 5] = Float.NaN;
			}
			if (uv) {
				FloatTuple t = obj.getTexCoord(face.getTexCoordIndex(i));
				vertices[o + 6] = t.getX();
				vertices[o + 7] = t.getDimensions() > 1 ? t.getY() : 0;
			} else {
				vertices[o + 6] = vertices[o + 7] = 0;
			}
		}
	}
}
