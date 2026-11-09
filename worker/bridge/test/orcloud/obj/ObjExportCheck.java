package orcloud.obj;

import java.io.File;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Enumeration;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.file.GeneralRocketLoader;
import info.openrocket.core.file.wavefrontobj.ObjUtils;
import info.openrocket.core.file.wavefrontobj.export.OBJExportOptions;
import info.openrocket.core.file.wavefrontobj.export.OBJExporterFactory;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.RocketComponent;
import orcloud.flight.Core;

/**
 * Exports every bundled example as a 3D file with the export dialog's "3D printing" settings
 * (Delaunay triangulation): the whole rocket at each level of detail, and each component with its
 * children at high detail. With OpenRocket 24.12's TriangulationHelper the pod examples fail ("Cannot
 * project a degenerate polygon onto a 2D plane"); the browser build's copy
 * (worker/bridge/web/info/openrocket/core/file/wavefrontobj) goes ahead of OpenRocket.jar here.
 *   java -cp TriangulationHelper-copy:OpenRocket.jar:classes orcloud.obj.ObjExportCheck
 */
public final class ObjExportCheck {
	private ObjExportCheck() {
	}

	public static void main(String[] args) throws Exception {
		Core.start();
		String jar = null;
		for (String p : System.getProperty("java.class.path").split(File.pathSeparator)) {
			if (p.endsWith("OpenRocket.jar")) {
				jar = p;
			}
		}
		int exports = 0;
		Set<String> failures = new TreeSet<>();
		File out = File.createTempFile("export", ".obj");
		try (JarFile jf = new JarFile(jar)) {
			for (Enumeration<JarEntry> en = jf.entries(); en.hasMoreElements();) {
				String name = en.nextElement().getName();
				if (!name.startsWith("datafiles/examples/") || !name.endsWith(".ork")) {
					continue;
				}
				String example = name.substring("datafiles/examples/".length(), name.length() - 4);
				Path file = Files.createTempFile("example", ".ork");
				try (InputStream in = jf.getInputStream(jf.getEntry(name))) {
					Files.copy(in, file, StandardCopyOption.REPLACE_EXISTING);
				}
				OpenRocketDocument doc = new GeneralRocketLoader(file.toFile()).load();
				Rocket rocket = doc.getRocket();
				FlightConfiguration config = rocket.getSelectedConfiguration();
				for (RocketComponent c : rocket) {
					for (ObjUtils.LevelOfDetail lod : ObjUtils.LevelOfDetail.values()) {
						if (!(c instanceof Rocket) && lod != ObjUtils.LevelOfDetail.HIGH_QUALITY) {
							continue;
						}
						OBJExportOptions o = new OBJExportOptions(rocket);
						o.setExportChildren(true);
						o.setExportMotors(false);
						o.setExportAppearance(false);
						o.setRemoveOffset(true);
						o.setScaling(1000);
						o.setTriangulate(true);
						o.setTriangulationMethod(ObjUtils.TriangulationMethod.DELAUNAY);
						o.setLOD(lod);
						exports++;
						try {
							new OBJExporterFactory(List.of(c), config, out, o, new WarningSet()).doExport();
						} catch (Exception e) {
							failures.add(example + " / " + c.getName() + " (" + lod + "): " + e);
						}
					}
				}
				Files.delete(file);
			}
		}
		out.delete();
		for (String f : failures) {
			System.out.println("  FAIL " + f);
		}
		System.out.println(failures.isEmpty() ? "OBJCHECK PASS exports=" + exports
				: "OBJCHECK FAILED: " + failures.size() + " of " + exports + " exports");
		System.exit(failures.isEmpty() ? 0 : 1);
	}
}
