/*
 * Copy of OpenRocket 24.12's FinSetExporter (GPL-3.0, (c) the OpenRocket team) for the browser
 * build, placed ahead of OpenRocket.jar on the class path. One change, marked "orcloud": fins are
 * exported with their cross section (orcloud.fins.AirfoilFin), which OpenRocket ignores: rounded
 * fins with rounded edges, airfoil fins with the profile chosen in the export dialog
 * (orcloud.web.FinProfiles). Square fins, fin tabs, and outlines with no single chord at some
 * height stay flat as before. The 3D view builds its fins with this too.
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
import info.openrocket.core.util.Coordinate;

import java.util.ArrayList;
import java.util.List;

import de.javagl.obj.FloatTuple;
import info.openrocket.core.file.wavefrontobj.DefaultObjFace;
import orcloud.fins.AirfoilFin;
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

        // Generate the fin meshes
        for (InstanceContext context : getInstanceContexts()) {
            generateMesh(floatPoints, floatTabPoints, thickness, hasTabs, context, shaped);
        }
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
        final int v0 = obj.getNumVertices();
        final int n0 = obj.getNumNormals();
        for (double[] v : fin.vertices) {
            obj.addVertex(transformer.convertLoc(v[0], v[1], v[2]));
        }
        for (double[] n : fin.normals) {
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
        for (int[] t : fin.triangles) {
            final int[] v = mirrored ? new int[] {v0 + t[0], v0 + t[2], v0 + t[1]} : new int[] {v0 + t[0], v0 + t[1], v0 + t[2]};
            final int[] n = mirrored ? new int[] {n0 + t[3], n0 + t[5], n0 + t[4]} : new int[] {n0 + t[3], n0 + t[4], n0 + t[5]};
            obj.addFace(new DefaultObjFace(v, null, n));
        }
    }

    private void generateMesh(FloatPoints floatPoints, FloatPoints floatTabPoints, float thickness,
                              boolean hasTabs, InstanceContext context, AirfoilFin shaped) {
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
