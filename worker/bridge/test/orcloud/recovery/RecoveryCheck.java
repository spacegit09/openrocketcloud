package orcloud.recovery;

import java.io.File;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.jar.JarFile;

import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.file.GeneralRocketLoader;
import info.openrocket.core.rocketcomponent.Parachute;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.simulation.FlightDataBranch;
import info.openrocket.core.simulation.FlightDataType;

/**
 * Checks the recovery and ballast helpers (Recovery): black powder as rocketry's charts have it
 * (0.55 g for a 3 x 10 inch bay at 15 psi); shear pin sums that agree both ways; charges for
 * every way of packing the parachute within what T. Fetter's ground tests needed; a parachute
 * sized for a descent rate lands at that rate in OpenRocket's own simulation (one parachute; a
 * main with a drogue open too); nose weight that gives the design view's stability its target for
 * every motor configuration, worked out again with the weight in place, and taken out when not
 * needed; a target no weight there reaches; the bay around a parachute, closed off by bulkheads in
 * it or reaching into it.
 *   java -cp OpenRocket.jar:classes orcloud.recovery.RecoveryCheck
 */
public final class RecoveryCheck {
	private static int failures;

	public static void main(String[] args) throws Exception {
		orcloud.flight.Core.start();

		// Black powder: a 3 x 10 inch bay at 15 psi takes about 0.55 g.
		double in = 0.0254, psi = 6894.757293168;
		double volume = Math.PI * Math.pow(1.5 * in, 2) * 10 * in;
		double grams = 1000 * Recovery.blackPowder(15 * psi, volume);
		System.out.printf("  black powder, 3 x 10 in at 15 psi: %.3f g%n", grams);
		check(Math.abs(grams - 0.547) < 0.005, "black powder " + grams + " g, not 0.547");

		// Shear pins: 15 psi on a 3 inch bulkhead pushes 472 N (106 lbf): one 2-56 pin (31 lbf) with a 2x margin.
		double pin = Recovery.ShearPin.NYLON_2_56.newtons;
		check(Recovery.pinsBroken(15 * psi, pin, 3 * in) == 1, "pins broken at 15 psi: " + Recovery.pinsBroken(15 * psi, pin, 3 * in));
		for (int n = 1; n <= 6; n++) {
			double p = Recovery.pressureForPins(n, pin, 3 * in);
			check(Recovery.pinsBroken(p, pin, 3 * in) == n, n + " pins: pressure " + p + " breaks " + Recovery.pinsBroken(p, pin, 3 * in));
		}
		System.out.printf("  three 2-56 pins in a 3 in bay: %.1f psi%n", Recovery.pressureForPins(3, pin, 3 * in) / psi);

		// The charge for two 2-56 pins against T. Fetter's ground tests (NARCON 2025): at least what
		// first separated the bay and at most twice what ejected it hard (a tube burst at 1.5-2 times
		// that), for each way he packed it. {diameter in, length in, packing, separated g, hard g}.
		Object[][] fetter = {
				{ "TR-1, parachute fills it", 2.15, 9.0, Recovery.Packing.FULL, 1.0, 1.3 },
				{ "VTS-1, two parachutes fill it", 3.0, 15.0, Recovery.Packing.FULL, 1.2, 1.9 },
				{ "VTS-1, parachute in the half by the charge", 3.0, 15.0, Recovery.Packing.HALF, 0.7, 1.0 },
				{ "VTS-1, parachute in the far half", 3.0, 15.0, Recovery.Packing.SMALL, 0.5, 0.5 },
				{ "VTS-1, small parachute by the charge", 3.0, 15.0, Recovery.Packing.SMALL, 0.3, 0.5 },
				{ "VTS-1, parachute behind a piston", 3.0, 15.0, Recovery.Packing.SMALL, 0.5, 0.7 } };
		for (Object[] t : fetter) {
			double d = (Double) t[1] * in, v = Math.PI * d * d / 4 * (Double) t[2] * in;
			double g = 1000 * Recovery.charge(Recovery.pressureForPins(2, pin, d), v, (Recovery.Packing) t[3]);
			double separated = (Double) t[4], hard = (Double) t[5];
			System.out.printf("  %s: %.2f g (tested: separated at %.1f g, hard at %.1f g)%n", t[0], g, separated, hard);
			check(g >= separated && g <= 2 * hard, t[0] + ": " + g + " g, not " + separated + " to " + 2 * hard);
		}

		// A parachute sized for 5 m/s lands at 5 m/s in OpenRocket's simulation.
		landsAt("A simple model rocket", 5.0);
		landsAt("Dual parachute deployment", 6.0);

		// Nose weight: the design view's stability reaches the target for every motor configuration.
		OpenRocketDocument doc = load("A simple model rocket");
		Rocket rocket = doc.getRocket();
		RocketComponent nose = Recovery.noseOf(rocket);
		check(Math.abs(Recovery.front(nose)) < 1e-9, "the nose cone's front at " + Recovery.front(nose));
		double x = nose.getLength() / 3, target = 3.0;
		double weight = needed(rocket, target, x);
		System.out.printf("  nose weight for %.1f calibers at %.0f mm: %.1f g%n", target, x * 1000, weight * 1000);
		check(weight > 0, "no nose weight needed for 3 calibers");
		Recovery.setNoseWeight(nose, weight, x);
		double lowest = Double.POSITIVE_INFINITY;
		for (var config : rocket.getFlightConfigurations()) {
			if (config.hasMotors()) {
				lowest = Math.min(lowest, Recovery.stability(config).margin());
			}
		}
		System.out.printf("  with it, the least stable configuration: %.4f calibers%n", lowest);
		check(Math.abs(lowest - target) < 0.002, "with the weight, stability " + lowest + ", not " + target);
		// Worked out again with the weight in place: the same weight (all of it, not more).
		check(Math.abs(needed(rocket, target, x) - weight) < 1e-6, "weight worked out again: " + needed(rocket, target, x) + " vs " + weight);
		// A target it already meets: none, and the weight comes out.
		double none = needed(rocket, 1.0, x);
		check(none == 0, "weight for 1 caliber: " + none);
		Recovery.setNoseWeight(nose, none, x);
		check(Recovery.noseWeightIn(nose) == null, "nose weight not taken out");
		// A target no weight in the nose reaches.
		check(Double.isNaN(needed(rocket, 60, x)), "weight for 60 calibers: " + needed(rocket, 60, x));

		// The bay around the parachute: inside its tube, between what closes it off.
		Parachute chute = Recovery.parachutes(rocket).get(0);
		Recovery.Bay bay = Recovery.bayOf(chute);
		System.out.printf("  bay of %s: %s, %.1f mm across, from %.1f to %.1f mm (tube %.1f mm long)%n", chute.getName(), bay.tube.getName(),
				bay.diameter * 1000, bay.from * 1000, bay.to * 1000, bay.tube.getLength() * 1000);
		check(bay.from >= 0 && bay.to > bay.from && bay.to <= bay.tube.getLength() + 1e-9 && Math.abs(bay.diameter - 2 * bay.tube.getInnerRadius()) < 1e-12,
				"bay " + bay.from + "-" + bay.to);

		// Bays closed off by parts reaching into their tubes: the main's starts behind the bulkhead in
		// the nose cone's coupler, the drogue's ends at the bulkhead in the coupler behind it.
		Rocket dual = load("Dual parachute deployment").getRocket();
		for (Parachute p : Recovery.parachutes(dual)) {
			Recovery.Bay b = Recovery.bayOf(p);
			double x0 = Recovery.front(b.tube), from = 0, to = b.tube.getLength();
			double mid = Recovery.front(p) - x0 + p.getLength() / 2;
			for (RocketComponent c : dual) {
				if (c instanceof info.openrocket.core.rocketcomponent.Bulkhead) {
					double top = Recovery.front(c) - x0, end = top + c.getLength();
					if (end > 0 && end <= mid) {
						from = Math.max(from, end);
					} else if (top >= mid && top < to) {
						to = top;
					}
				}
			}
			System.out.printf("  dual deployment, bay of %s: %.1f to %.1f mm of its %.1f mm tube%n", p.getName(), b.from * 1000, b.to * 1000,
					b.tube.getLength() * 1000);
			check(Math.abs(b.from - from) < 1e-9 && Math.abs(b.to - to) < 1e-9, p.getName() + ": bay " + b.from + "-" + b.to + ", not " + from + "-" + to);
		}
		check(Recovery.bayOf(Recovery.parachutes(dual).get(0)).from > 0.05, "the main's bay does not start behind the nose's bulkhead");

		// Nose weight with several motor configurations: the least stable gets the target exactly,
		// once the weight is in.
		RocketComponent dualNose = Recovery.noseOf(dual);
		double dx = dualNose.getLength() / 3, w5 = needed(dual, 5, dx);
		Recovery.setNoseWeight(dualNose, w5, dx);
		double least = Double.POSITIVE_INFINITY;
		for (var config : dual.getFlightConfigurations()) {
			if (config.hasMotors()) {
				least = Math.min(least, Recovery.stability(config).margin());
			}
		}
		System.out.printf("  dual deployment, %.0f g of nose weight for 5 calibers: the least stable configuration %.4f%n", w5 * 1000, least);
		check(Math.abs(least - 5) < 0.002, "dual deployment with the weight: " + least + " calibers, not 5");
		check(Math.abs(needed(dual, 5, dx) - w5) < 1e-6, "dual deployment, worked out again: " + needed(dual, 5, dx) + " vs " + w5);
		// Its stage's mass is overridden along with what is in it: the weight moves the centre of
		// gravity without adding mass (the sums above follow OpenRocket's mass calculation).
		check(Recovery.massOverriddenAround(dualNose) == dual.getChild(0), "the stage's overridden mass not noticed: " + Recovery.massOverriddenAround(dualNose));
		// A nose cone whose centre of gravity is overridden along with what is in it: the weight adds
		// its mass there instead, and the target is still met exactly.
		dualNose.setCGOverridden(true);
		dualNose.setSubcomponentsOverriddenCG(true);
		dualNose.setOverrideCGX(dualNose.getLength() / 2);
		double w6 = needed(dual, 6, dx);
		Recovery.setNoseWeight(dualNose, w6, dx);
		double least6 = Double.POSITIVE_INFINITY;
		for (var config : dual.getFlightConfigurations()) {
			if (config.hasMotors()) {
				least6 = Math.min(least6, Recovery.stability(config).margin());
			}
		}
		System.out.printf("  dual deployment, nose cone's centre of gravity overridden: %.0f g for 6 calibers gives %.4f%n", w6 * 1000, least6);
		check(Math.abs(least6 - 6) < 0.002, "with the nose's centre of gravity overridden: " + least6 + " calibers, not 6");
		// Its mass overridden too: weight there changes nothing.
		dualNose.setMassOverridden(true);
		dualNose.setSubcomponentsOverriddenMass(true);
		boolean noEffect = true;
		for (Recovery.Response r : Recovery.responses(dual, dx)) {
			noEffect &= r.noEffect();
		}
		check(noEffect && Double.isNaN(needed(dual, 7, dx)), "weight in a nose cone with its mass and centre of gravity overridden: " + needed(dual, 7, dx));

		System.out.println("RECOVERYCHECK " + (failures == 0 ? "PASS" : "FAILED " + failures));
		System.exit(failures == 0 ? 0 : 1);
	}

	/** The most nose weight any motor configuration needs (NaN if one cannot get there). */
	private static double needed(Rocket rocket, double target, double x) {
		double most = 0;
		for (Recovery.Response r : Recovery.responses(rocket, x)) {
			double w = r.weightFor(target);
			if (Double.isNaN(w)) {
				return Double.NaN;
			}
			most = Math.max(most, w);
		}
		return most;
	}

	/** Sizes the example's main parachute for `rate` and checks the simulation lands at it. */
	private static void landsAt(String example, double rate) throws Exception {
		OpenRocketDocument doc = load(example);
		Simulation sim = doc.getSimulations().get(0);
		// The main: the largest.
		Parachute main = Recovery.parachutes(doc.getRocket()).stream().max((a, b) -> Double.compare(a.getDiameter(), b.getDiameter())).get();
		Recovery.ParachuteCase c = Recovery.parachute(main, sim.getActiveConfiguration());
		double rho = Recovery.airDensity(sim.getOptions().getLaunchAltitude());
		double d = c.diameterFor(rate, main.getCD(), rho, true, Double.NaN);
		check(Math.abs(c.rate(d, main.getCD(), rho, true, Double.NaN) - rate) < 1e-3, example + ": rate at that size " + c.rate(d, main.getCD(), rho, true, Double.NaN));
		if (!c.others.isEmpty()) {
			// A smaller one open with a bigger: no size of it brings the rocket down faster than the bigger alone.
			Parachute drogue = Recovery.parachutes(doc.getRocket()).stream().filter((p) -> p != main).findFirst().get();
			double none = Recovery.parachute(drogue, sim.getActiveConfiguration()).diameterFor(rate, drogue.getCD(), rho, true, Double.NaN);
			check(Double.isNaN(none), example + ": the drogue sized for " + rate + " m/s with the main open: " + none);
		}
		main.setDiameter(d);
		Simulation run = sim.copy();
		run.getOptions().setWindSpeedAverage(0);
		run.getOptions().setWindSpeedDeviation(0);
		run.simulate();
		FlightDataBranch b = run.getSimulatedData().getBranch(0);
		List<Double> vz = b.get(FlightDataType.TYPE_VELOCITY_Z);
		double landing = -vz.get(vz.size() - 1);
		System.out.printf("  %s: %s (others open: %s) sized %.0f mm for %.1f m/s; OpenRocket lands it at %.2f m/s%n", example, main.getName(),
				c.others, d * 1000, rate, landing);
		// OpenRocket counts the rocket's own drag too, so it comes down a little slower.
		check(landing <= rate * 1.02 && landing > rate * 0.9, example + ": lands at " + landing + " m/s, not about " + rate);
	}

	static OpenRocketDocument load(String example) throws Exception {
		String jar = null;
		for (String p : System.getProperty("java.class.path").split(File.pathSeparator)) {
			if (p.endsWith("OpenRocket.jar") || p.endsWith("OpenRocket-24.12.jar")) {
				jar = p;
			}
		}
		try (JarFile jf = new JarFile(jar)) {
			Path file = Files.createTempFile("example", ".ork");
			try (InputStream in = jf.getInputStream(jf.getEntry("datafiles/examples/" + example + ".ork"))) {
				Files.copy(in, file, StandardCopyOption.REPLACE_EXISTING);
			}
			OpenRocketDocument doc = new GeneralRocketLoader(file.toFile()).load();
			Files.delete(file);
			return doc;
		}
	}

	private static void check(boolean ok, String what) {
		if (!ok) {
			failures++;
			System.out.println("  FAIL " + what);
		}
	}
}
