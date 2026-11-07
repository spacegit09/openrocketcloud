package orcloud.flight;

import com.google.inject.AbstractModule;

import info.openrocket.core.database.ComponentPresetDao;
import info.openrocket.core.database.ComponentPresetDatabase;
import info.openrocket.core.plugin.PluginModule;
import info.openrocket.core.startup.OpenRocketCore;

/**
 * Starts OpenRocket without its windows, for computing flight tables. OpenRocket 24.12's own
 * headless start-up leaves out the component preset service that loading a design asks for when it
 * uses parts from the parts library (the desktop app binds it in its GUI module), so it is added.
 */
public final class Core {
	private static boolean started;

	private Core() {
	}

	public static synchronized void start() {
		if (started) {
			return;
		}
		OpenRocketCore.initialize(new PluginModule(), new AbstractModule() {
			@Override
			protected void configure() {
				bind(ComponentPresetDao.class).to(ComponentPresetDatabase.class);
			}
		});
		started = true;
	}
}
