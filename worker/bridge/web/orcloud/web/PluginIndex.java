package orcloud.web;

import io.github.classgraph.ClassGraph;
import io.github.classgraph.ClassInfo;
import io.github.classgraph.ScanResult;

/**
 * Build step, run on a regular JVM: lists the classes in OpenRocket.jar annotated with @Plugin,
 * one per line, for the browser's AnnotationFinderImpl (CheerpJ can't run the ClassGraph scan).
 */
public final class PluginIndex {
	public static void main(String[] args) {
		try (ScanResult scan = new ClassGraph().enableAllInfo().acceptPackages("info.openrocket").scan()) {
			for (ClassInfo c : scan.getClassesWithAnnotation("info.openrocket.core.plugin.Plugin")) {
				System.out.println(c.getName());
			}
		}
	}
}
