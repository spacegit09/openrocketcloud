/*
 * Copy of OpenRocket 24.12's FinSetExporter (GPL-3.0, (c) the OpenRocket team) for the browser
 * build, placed ahead of OpenRocket.jar on the class path. Two changes, marked "orcloud", both
 * things OpenRocket knows about a fin set but leaves out of its 3D shape:
 * - Fins are exported with their cross section (orcloud.fins.AirfoilFin): rounded fins with rounded
 *   edges, airfoil fins with the profile chosen in the export dialog (orcloud.web.FinProfiles).
 *   Square fins, fin tabs, and outlines with no single chord at some height stay flat as before.
 * - A fin set with a fillet radius (Root fillets, in its dialog) gets its root fillets, on both
 *   sides of every fin, of that radius (orcloud.fins.FinFillet), as OpenRocket assumes when it
 *   works out their mass.
 * The 3D view builds its fins with this too.
 */
package info.openrocket.core.file.wavefrontobj.export.components;

import com.sun.istack.NotNull;
import info.openrocket.core.file.wavefrontobj.CoordTransform;
import info.openrocket.core.file.wavefrontobj.DefaultObj;
import info.openrocket.core.file.wavefrontobj.ObjUtils;
import info.openrocket.core.file.wavefrontobj.export.shapes.PolygonExporter;
import info.openrocket.core.logging.Warning;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.rocketcomponent.FinSet;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.InstanceContext;
import info.openrocket.core.rocketcomponent.SymmetricComponent;
import info.openrocket.core.util.Coordinate;

import java.util.ArrayList;
import java.util.List;

import de.javagl.obj.FloatTuple;
import info.openrocket.core.file.wavefrontobj.DefaultObjFace;
import orcloud.fins.AirfoilFin;
import orcloud.fins.FinFillet;
import orcloud.fins.FinProfile;
import orcloud.web.FinProfiles;

public class FinSetExporter extends RocketComponentExporter<FinSet> {
    public FinSetExporter(@NotNull DefaultObj obj, FlightConfiguration config, @NotNull CoordTransform transformer,
                          FinSet component, String groupName, ObjUtils.LevelOfDetail LOD, boolean exportAllInstances,
                          WarningSet warnings) {
        super(obj, config, transformer, component, groupName, LOD, exportAllInstances, warnings);
    }

    @Override
    public void addToObj() {
        obj.setActiveGroupNames(groupName);

        final Coordinate[] points = component.getFinPointsWithRoot();
        final Coordinate[] tabPoints = component.getTabPointsWithRoot();
        final Coordinate[] tabPointsReversed = new Coordinate[tabPoints.length];        // We need clockwise points for the PolygonExporter
        for (int i = 0; i < tabPoints.length; i++) {
            tabPointsReversed[i] = tabPoints[tabPoints.length - i - 1];
        }
        final FloatPoints floatPoints = getPointsAsFloat(points);
        final FloatPoints floatTabPoints = getPointsAsFloat(tabPointsReversed);
        final float thickness = (float) component.getThickness();
        boolean hasTabs = component.getTabLength() > 0 && component.getTabHeight() > 0;

        if (Float.compare(thickness, 0) == 0) {
            warnings.add(Warning.OBJ_ZERO_THICKNESS, component);
        }

        // orcloud: the fin with its cross section, or null to export it flat.
        final FinProfile profile = FinProfiles.forFin(component);
        final AirfoilFin shaped = profile == null || thickness <= 0 ? null
                : AirfoilFin.build(points, component.getThickness(), profile, chordPoints());

        // orcloud: the root fillets, the same for every fin
        final FinFillet fillets = fillets(shaped != null ? profile : null);

        // Generate the fin meshes
        for (InstanceContext context : getInstanceContexts()) {
            generateMesh(floatPoints, floatTabPoints, thickness, hasTabs, context, shaped, fillets);
        }
    }

    /**
     * orcloud: the fin's root fillets in its own frame, or null for none: along the part of the root
     * on the body, following the body's radius and (with `profile`) the fin's thickness.
     */
    private FinFillet fillets(FinProfile profile) {
        final double radius = component.getFilletRadius();
        if (!(radius > 0) || !(component.getParent() instanceof SymmetricComponent)) {
            return null;
        }
        final SymmetricComponent body = (SymmetricComponent) component.getParent();
        final Coordinate front = component.getFinFront();
        final Coordinate[] root = component.getRootPoints();
        if (root.length < 2) {
            return null;
        }
        final double x0 = root[0].x, x1 = root[root.length - 1].x;
        final double chord = x1 - x0;
        final double thickness = component.getThickness();
        // Stations: the root's points, more along the chord for a profile, within the body's length.
        final double from = Math.max(x0, -front.x), to = Math.min(x1, body.getLength() - front.x);
        if (!(to - from > 1e-6) || !(chord > 1e-9)) {
            return null;
        }
        final List<Double> stations = new ArrayList<>();
        for (Coordinate p : root) {
            stations.add(p.x);
        }
        if (profile != null && profile.type != FinProfile.Type.FLAT) {
            final int n = chordPoints();
            for (int k = 1; k < n; k++) {
                stations.add(x0 + chord * k / n);
            }
        }
        final double embed = body.isFilled() ? radius / 4 : Math.min(body.getThickness() / 2, radius / 4);
        final int segments = LOD == ObjUtils.LevelOfDetail.LOW_QUALITY ? 4 : LOD == ObjUtils.LevelOfDetail.HIGH_QUALITY ? 16 : 8;
        // At the fin's leading and trailing edges the fillets run out; where the body ends under the
        // fin, they stop flush with it.
        return FinFillet.build(from, to, stations.stream().mapToDouble(Double::doubleValue).toArray(),
                x -> rootHeight(root, x) - body.getRadius(front.x + x), // the body's axis, below the root
                x -> body.getRadius(front.x + x),
                x -> profile == null ? thickness / 2 : profile.half((x - x0) / chord, chord, thickness),
                radius, embed, segments, from <= x0 + 1e-9, to >= x1 - 1e-9);
    }

    /** orcloud: the root's height at x (between its points). */
    private static double rootHeight(Coordinate[] root, double x) {
        for (int k = 1; k < root.length; k++) {
            if (x <= root[k].x || k == root.length - 1) {
                final double dx = root[k].x - root[k - 1].x;
                final double t = dx > 0 ? Math.max(0, Math.min(1, (x - root[k - 1].x) / dx)) : 0;
                return root[k - 1].y + t * (root[k].y - root[k - 1].y);
            }
        }
        return root[0].y;
    }

    /** orcloud: points along each chord for the level of detail. */
    private int chordPoints() {
        if (LOD == null) {
            return 16;
        }
        switch (LOD) {
            case LOW_QUALITY: return 8;
            case HIGH_QUALITY: return 32;
            default: return 16;
        }
    }

    /**
     * orcloud: adds the fin with its cross section, in the fin's frame as addPolygonMesh draws it,
     * its triangles facing out (counter-clockwise) in the OBJ's own axes.
     */
    private void addShapedMesh(AirfoilFin fin) {
        addMesh(fin.vertices, fin.normals, fin.triangles);
    }

    /** orcloud: adds a mesh in the fin's frame (vertices, normals, triangles as AirfoilFin has them). */
    private void addMesh(List<double[]> vertices, List<double[]> normals, List<int[]> triangles) {
        final int v0 = obj.getNumVertices();
        final int n0 = obj.getNumNormals();
        for (double[] v : vertices) {
            obj.addVertex(transformer.convertLoc(v[0], v[1], v[2]));
        }
        for (double[] n : normals) {
            obj.addNormal(transformer.convertLocWithoutOriginOffs(n[0], n[1], n[2]));
        }
        // A transform that mirrors (axes swapped or turned around) turns the winding too.
        final FloatTuple ex = transformer.convertLocWithoutOriginOffs(1, 0, 0);
        final FloatTuple ey = transformer.convertLocWithoutOriginOffs(0, 1, 0);
        final FloatTuple ez = transformer.convertLocWithoutOriginOffs(0, 0, 1);
        final double det = ex.getX() * (ey.getY() * ez.getZ() - ey.getZ() * ez.getY())
                - ex.getY() * (ey.getX() * ez.getZ() - ey.getZ() * ez.getX())
                + ex.getZ() * (ey.getX() * ez.getY() - ey.getY() * ez.getX());
        final boolean mirrored = det < 0;
        for (int[] t : triangles) {
            final int[] v = mirrored ? new int[] {v0 + t[0], v0 + t[2], v0 + t[1]} : new int[] {v0 + t[0], v0 + t[1], v0 + t[2]};
            final int[] n = mirrored ? new int[] {n0 + t[3], n0 + t[5], n0 + t[4]} : new int[] {n0 + t[3], n0 + t[4], n0 + t[5]};
            obj.addFace(new DefaultObjFace(v, null, n));
        }
    }

    private void generateMesh(FloatPoints floatPoints, FloatPoints floatTabPoints, float thickness,
                              boolean hasTabs, InstanceContext context, AirfoilFin shaped, FinFillet fillets) {
        // Generate the mesh
        final int startIdx = obj.getNumVertices();
        final int normalsStartIdx = obj.getNumNormals();

        // Generate the instance mesh
        if (shaped != null) {
            addShapedMesh(shaped);  // orcloud
        } else {
            PolygonExporter.addPolygonMesh(obj, transformer, null,
                    floatPoints.getXCoords(), floatPoints.getYCoords(), thickness);
        }

        // orcloud: the root fillets
        if (fillets != null) {
            addMesh(fillets.vertices, fillets.normals, fillets.triangles);
        }

        // Generate the fin tabs
        if (hasTabs) {
            PolygonExporter.addPolygonMesh(obj, transformer, null,
                    floatTabPoints.getXCoords(), floatTabPoints.getYCoords(), thickness);
        }

        int endIdx = Math.max(obj.getNumVertices() - 1, startIdx);                  // Clamp in case no vertices were added
        int normalsEndIdx = Math.max(obj.getNumNormals() - 1, normalsStartIdx);     // Clamp in case no normals were added

        // First rotate for the cant angle
        /*
        Note: I first thought you had to do the cant rotation with the fin center as origin, but you just have to
        rotate around the fin start. The offset due to the cant rotation around the fin start is already taken care of by
        the component location.
         */
        FloatTuple rot = transformer.convertRot(0, component.getCantAngle(), 0);
        FloatTuple orig = transformer.convertLoc(0, 0, 0);
        ObjUtils.rotateVertices(obj, startIdx, endIdx, normalsStartIdx, normalsEndIdx,
                rot.getX(), rot.getY(), rot.getZ(),
                orig.getX(), orig.getY(), orig.getZ());

        // Then do the component rotation (axial rotation)
        final double rotX = context.transform.getXrotation();
        final double rotY = context.transform.getYrotation();
        final double rotZ = context.transform.getZrotation();
        rot = transformer.convertRot(rotX, rotY, rotZ);
        ObjUtils.rotateVertices(obj, startIdx, endIdx, normalsStartIdx, normalsEndIdx,
                rot.getX(), rot.getY(), rot.getZ(),
                orig.getX(), orig.getY(), orig.getZ());

        // Translate the mesh to the position in the rocket
        final Coordinate location = context.getLocation();
        ObjUtils.translateVerticesFromComponentLocation(obj, transformer, startIdx, endIdx, location);
    }

    /**
     * Converts the double fin points to float fin points and removes any duplicate points (OBJ can't handle this).
     * @param points The fin points
     * @return The fin points as floats
     */
    private FloatPoints getPointsAsFloat(Coordinate[] points) {
        // We first want to remove duplicate points, so we'll keep track of indices that are correct
        List<Integer> indices = new ArrayList<>();
        for (int i = 0; i < points.length; i++) {
            final int nextIdx = (i + 1) % points.length;
            if (!points[i].equals(points[nextIdx])) {
                indices.add(i);
            }
        }

        final int targetLength = indices.size();
        final float[] xCoords = new float[targetLength];
        final float[] yCoords = new float[targetLength];

        // Fill the arrays with the x and y values of each coordinate
        for (int i = 0; i < targetLength; i++) {
            xCoords[i] = (float) points[indices.get(i)].x;
            yCoords[i] = (float) points[indices.get(i)].y;
        }

        return new FloatPoints(xCoords, yCoords);
    }

    private record FloatPoints(float[] xCoords, float[] yCoords) {
        public float[] getXCoords() {
            return xCoords;
        }

        public float[] getYCoords() {
            return yCoords;
        }
    }
}
