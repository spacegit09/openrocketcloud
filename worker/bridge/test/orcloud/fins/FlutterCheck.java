package orcloud.fins;

/**
 * Checks the fin flutter estimate (FinFlutter) against published numbers: Bennett's worked example
 * (Apogee's Peak of Flight 615: a 1/8 in fin, 7.5 in root, 2.5 in tip, 3 in span, swept 4.285 in,
 * G 600,000 psi, at 7.2 psi and 1043.36 ft/s: 1425 ft/s, and 1991.7 and 2618.1 ft/s at 5/32 and
 * 3/16 in) and Martin's equation for a 4 x 4 in fin, 1/8 in thick, G 380,000 psi at 14.1735 psi:
 * flutter Mach 0.9581 (RocketPy issue 1200, where RocketPy's form gives sqrt(2) more). Also: the
 * same in any units, scaling with thickness and stiffness, epsilon from the sweep (never below
 * Martin's 1/4), a fin of any outline as its trapezoid, the lowest margin along a flight, the
 * standard atmosphere and the materials' typical stiffness.
 *   java -cp OpenRocket.jar:classes orcloud.fins.FlutterCheck
 */
public final class FlutterCheck {
	private static int failures;

	public static void main(String[] args) {
		double in = 0.0254, psi = 6894.757;

		// Bennett's worked example (Peak of Flight 615), in inches and psi, as he works it.
		double[] x = { 0, 4.285, 4.285 + 2.5, 7.5 }, y = { 0, 3, 3, 0 };
		double cx = FinFlutter.centroid(x, y);
		check(Math.abs(cx - 4.49) < 0.01, "Bennett's Cx 4.49 in: " + cx);
		FinFlutter bennett = new FinFlutter(7.5, 3, (7.5 + 2.5) / 2 * 3, 0.125, cx);
		check(Math.abs(bennett.epsilon - 0.349) < 0.001, "Bennett's epsilon 0.349: " + bennett.epsilon);
		check(Math.abs(bennett.aspectRatio - 0.6) < 1e-9 && Math.abs(bennett.taper - 1.0 / 3) < 1e-9, "aspect ratio 0.6, taper 1/3");
		double v = bennett.speed(600000, 7.2, 1043.36);
		check(Math.abs(v - 1425) < 3, "Bennett's 1/8 in fin: " + v + " ft/s, printed 1425");
		check(Math.abs(new FinFlutter(7.5, 3, 15, 5.0 / 32, cx).speed(600000, 7.2, 1043.36) - 1991.7) < 4, "5/32 in: printed 1991.7 ft/s");
		check(Math.abs(new FinFlutter(7.5, 3, 15, 3.0 / 16, cx).speed(600000, 7.2, 1043.36) - 2618.1) < 5, "3/16 in: printed 2618.1 ft/s");
		check(Math.abs(new FinFlutter(7.5 * in, 3 * in, 15 * in * in, 0.125 * in, cx * in).speed(600000 * psi, 7.2 * psi, 1043.36 * 0.3048)
				- v * 0.3048) < 1e-6, "the same in metres and pascals");

		// Martin's equation (epsilon 1/4: no sweep), the RocketPy issue's fin: flutter Mach 0.9581.
		FinFlutter square = new FinFlutter(4, 4, 16, 0.125, 2);
		check(square.epsilon == FinFlutter.MARTIN_EPSILON, "a fin without sweep has Martin's epsilon");
		double mach = square.speed(380000, 14.1735, 1);
		check(Math.abs(mach - 0.9581) < 0.0005, "Martin's equation: flutter Mach " + mach + ", want 0.9581");

		// Fins swept forward keep Martin's epsilon (Bennett's would give them a higher flutter speed).
		check(new FinFlutter(4, 4, 16, 0.125, 1.5).epsilon == FinFlutter.MARTIN_EPSILON, "swept forward: Martin's epsilon");
		check(Double.isNaN(FinFlutter.centroid(new double[] { 0, 1 }, new double[] { 0, 0 })) == true, "no area, no centre");

		double t = 0.125 * in, root = 6 * in, span = 4 * in, area = 16 * in * in;
		FinFlutter fin = new FinFlutter(root, span, area, t, Double.NaN);
		check(fin.valid() && fin.epsilon == FinFlutter.MARTIN_EPSILON, "no centre given: Martin's epsilon");
		check(Math.abs(fin.tipChord - 2 * in) < 1e-12, "the trapezoid's tip chord from its area: " + fin.tipChord);
		double g10 = 425000 * psi;
		FinFlutter thicker = new FinFlutter(root, span, area, 2 * t, Double.NaN);
		check(Math.abs(thicker.speed(g10, 101325, 340.294) / fin.speed(g10, 101325, 340.294) - Math.pow(2, 1.5)) < 1e-9,
				"twice as thick: 2^1.5 times as fast");
		check(Math.abs(fin.speed(4 * g10, 101325, 340.294) / fin.speed(g10, 101325, 340.294) - 2) < 1e-9, "four times as stiff: twice as fast");
		check(fin.speed(g10, 50000, 320) > fin.speed(g10, 101325, 320), "higher up (less pressure): faster");
		check(Math.abs(fin.speedAtSeaLevel(g10) - fin.speed(g10, 101325, 340.294)) < 1e-12, "sea level");

		// An elliptical fin counts as the trapezoid with its root, span and area.
		FinFlutter ellipse = new FinFlutter(root, span, Math.PI / 4 * root * span, t, root / 2);
		check(Math.abs(ellipse.tipChord - (Math.PI / 2 - 1) * root) < 1e-12, "an ellipse's trapezoid");
		check(!new FinFlutter(root, span, area, 0, Double.NaN).valid(), "no thickness, no estimate");

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
