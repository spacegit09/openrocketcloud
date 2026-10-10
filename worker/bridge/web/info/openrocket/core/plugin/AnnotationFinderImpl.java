package info.openrocket.core.plugin;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.lang.annotation.Annotation;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * Browser replacement for OpenRocket's class-path scanner, placed ahead of OpenRocket.jar on the
 * class path. Returns the @Plugin classes listed at build time (orcloud/plugins.txt, made by
 * orcloud.web.PluginIndex from the same OpenRocket.jar) instead of scanning with ClassGraph,
 * which doesn't run under CheerpJ.
 */
public class AnnotationFinderImpl implements AnnotationFinder {

	@Override
	public List<Class<?>> findAnnotatedTypes(Class<? extends Annotation> annotation) {
		List<Class<?>> classes = new ArrayList<>();
		if (annotation != Plugin.class) {
			return classes;
		}
		ClassLoader loader = AnnotationFinderImpl.class.getClassLoader();
		try (InputStream in = loader.getResourceAsStream("orcloud/plugins.txt")) {
			if (in == null) {
				throw new IllegalStateException("orcloud/plugins.txt is missing");
			}
			BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
			for (String line; (line = r.readLine()) != null;) {
				if (!line.isBlank()) {
					classes.add(Class.forName(line.trim(), false, loader));
				}
			}
		} catch (IOException | ClassNotFoundException e) {
			throw new IllegalStateException("Could not load the plugin list", e);
		}
		return classes;
	}
}
