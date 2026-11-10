package orcloud.fins;

/**
 * Checks the fin flutter estimate (FinFlutter): a worked example (a G10 fin, 6 in root, 2 in tip,
 * 4 in span, 1/8 in thick, at sea level: 1047 ft/s), the same in any units, how it scales with
 * thickness and stiffness, a fin of any outline as its trapezoid, the lowest margin along a flight,
 * the standard atmosphere and the materials' typical stiffness.
 *   java -cp OpenRocket.jar:classes orcloud.fins.FlutterCheck
 */
public final class FlutterCheck {
	private static int failures;

	public static void main(String[] args) {
		double in = 0.0254, psi = 6894.757;
		double root = 6 * in, tip = 2 * in, span = 4 * in, t = 0.125 * in;
		double area = (root + tip) / 2 * span;
		FinFlutter fin = new FinFlutter(root, span, area, t);
		double g10 = 425000 * psi;

		check(fin.valid(), "a fin");
		check(Math.abs(fin.tipChord - tip) < 1e-12, "the trapezoid's tip chord from its area: " + fin.tipChord);
		check(Math.abs(fin.aspectRatio - 1) < 1e-12 && Math.abs(fin.taper - 1.0 / 3) < 1e-12, "aspect ratio 1, taper 1/3");

		// AR 1, taper 1/3, t/c 1/48: 1116.4 ft/s * sqrt(425000 * 2 * 3 / 48^3 / (1.337 * 4/3 * 14.696)) = 1047.4 ft/s
		double v = fin.speed(g10, 14.696 * psi, 1116.4 * 0.3048);
		check(Math.abs(v / 0.3048 - 1047.4) < 0.5, "worked example: " + v / 0.3048 + " ft/s, want 1047.4");
		check(Math.abs(fin.speed(425000, 14.696, 1116.4 * 0.3048) - v) < 1e-9, "the same in psi as in Pa");
		check(Math.abs(fin.speedAtSeaLevel(g10) - fin.speed(g10, 101325, 340.294)) < 1e-12, "sea level");

		FinFlutter thicker = new FinFlutter(root, span, area, 2 * t);
		check(Math.abs(thicker.speed(g10, 101325, 340.294) / fin.speed(g10, 101325, 340.294) - Math.pow(2, 1.5)) < 1e-9,
				"twice as thick: 2^1.5 times as fast");
		check(Math.abs(fin.speed(4 * g10, 101325, 340.294) / fin.speed(g10, 101325, 340.294) - 2) < 1e-9, "four times as stiff: twice as fast");
		check(fin.speed(g10, 50000, 320) > fin.speed(g10, 101325, 320), "higher up (less pressure): faster");

		// An elliptical fin counts as the trapezoid with its root, span and area.
		FinFlutter ellipse = new FinFlutter(root, span, Math.PI / 4 * root * span, t);
		check(Math.abs(ellipse.tipChord - (Math.PI / 2 - 1) * root) < 1e-12, "an ellipse's trapezoid");
		check(!new FinFlutter(root, span, area, 0).valid(), "no thickness, no estimate");

		// The lowest margin along a flight: at its fastest, low down.
		double[] airspeed = { 0, 50, 150, 240, 230, 120, 0.5 };
		double[] pressure = new double[airspeed.length], sound = new double[airspeed.length];
		for (int i = 0; i < airspeed.length; i++) {
			double[] air = FinFlutter.standardAir(100 + 200 * i);
			pressure[i] = air[0];
			sound[i] = air[1];
		}
		FinFlutter.Margin m = fin.lowest(g10, airspeed, pressure, sound);
		check(m != null && m.index == 3, "the lowest margin where it flies fastest: " + (m == null ? null : m.index));
		check(m != null && Math.abs(m.factor - m.flutterSpeed / m.airspeed) < 1e-12 && Math.abs(m.flutterSpeed - fin.speed(g10, pressure[3], sound[3])) < 1e-9,
				"its flutter speed and factor");
		check(fin.lowest(g10, new double[] { 0, 0.5 }, new double[] { 101325, 101325 }, new double[] { 340, 340 }) == null, "no flight, no margin");

		double[] sea = FinFlutter.standardAir(0), tropopause = FinFlutter.standardAir(11000), high = FinFlutter.standardAir(20000);
		check(Math.abs(sea[0] - 101325) < 1 && Math.abs(sea[1] - 340.29) < 0.05, "standard air at sea level: " + sea[0] + " Pa, " + sea[1] + " m/s");
		check(Math.abs(tropopause[0] - 22632) < 5 && Math.abs(tropopause[1] - 295.07) < 0.05, "at 11 km: " + tropopause[0] + " Pa, " + tropopause[1] + " m/s");
		check(Math.abs(high[0] - 5474.9) < 2, "at 20 km: " + high[0] + " Pa");

		check(FinFlutter.typicalShearModulus("Plywood (birch)") == 0.62e9 && FinFlutter.typicalShearModulus("Fiberglass") == 2.93e9,
				"typical stiffness of plywood and G10");
		check(Double.isNaN(FinFlutter.typicalShearModulus("My own composite")), "none for a custom material");
		check(FinFlutter.typicalShearModulus("G10 Fiberglass") == 2.93e9 && FinFlutter.typicalShearModulus("Aircraft plywood (Birch)") == 0.62e9
				&& FinFlutter.typicalShearModulus("Aluminium 6061") == 26e9, "names from parts libraries");
		check(Double.isNaN(FinFlutter.typicalShearModulus("Placard")), "no match inside other words");

		System.out.println(failures == 0 ? "FLUTTERCHECK PASS" : "FLUTTERCHECK FAILED: " + failures);
		System.exit(failures == 0 ? 0 : 1);
	}

	private static void check(boolean ok, String what) {
		if (!ok) {
			failures++;
			System.out.println("  FAIL " + what);
		}
	}
}
