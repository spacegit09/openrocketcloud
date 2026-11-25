package orcloud.bridge;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.github.jbgust.jsrm.application.JSRMConfig;
import com.github.jbgust.jsrm.application.JSRMConfigBuilder;
import com.github.jbgust.jsrm.application.JSRMSimulation;
import com.github.jbgust.jsrm.application.exception.ChamberPressureOutOfBoundException;
import com.github.jbgust.jsrm.application.exception.InvalidMotorDesignException;
import com.github.jbgust.jsrm.application.exception.MotorClassificationOutOfBoundException;
import com.github.jbgust.jsrm.application.motor.CombustionChamber;
import com.github.jbgust.jsrm.application.motor.PropellantGrain;
import com.github.jbgust.jsrm.application.motor.SolidRocketMotor;
import com.github.jbgust.jsrm.application.motor.grain.CSlotGrain;
import com.github.jbgust.jsrm.application.motor.grain.EndBurnerGrain;
import com.github.jbgust.jsrm.application.motor.grain.FinocylGrain;
import com.github.jbgust.jsrm.application.motor.grain.GrainConfigutation;
import com.github.jbgust.jsrm.application.motor.grain.GrainSurface;
import com.github.jbgust.jsrm.application.motor.grain.HollowCylinderGrain;
import com.github.jbgust.jsrm.application.motor.grain.MoonBurnerGrain;
import com.github.jbgust.jsrm.application.motor.grain.RodAndTubeGrain;
import com.github.jbgust.jsrm.application.motor.grain.StarGrain;
import com.github.jbgust.jsrm.application.motor.propellant.PropellantType;
import com.github.jbgust.jsrm.application.result.JSRMResult;
import com.github.jbgust.jsrm.application.result.MotorParameters;
import com.github.jbgust.jsrm.application.result.Nozzle;

/**
 * A solid rocket motor worked out by JSRM 3.3 (github.com/jbgust/jsrm, GPL-3.0): the Java
 * version of Richard Nakka's SRM spreadsheet that METEOR (meteor.open-sky.fr) runs, with
 * SRM_2023's propellants. The page describes the motor as JSON (web/src/motor/srm.js):
 * { propellant, chamber: { diameter, length }, throat, grain: { type, ... }, settings: { ... } },
 * lengths in millimetres. The answers are JSRM's own numbers, unrounded.
 */
final class MotorLab {
	private MotorLab() {
	}

	/** Points of a grain's burning area for the Kn table: SRM's 50 steps of web regression. */
	private static final int AREA_STEPS = 50;

	/** The whole calculation: SRM's Pressure and Performance worksheets, line by line. */
	static String simulate(Map<String, Object> m) {
		try {
			SolidRocketMotor motor = motor(m);
			JSRMConfig config = config(map(m.get("settings")));
			JSRMResult r = new JSRMSimulation(motor).run(config);
			Map<String, Object> out = new LinkedHashMap<>();
			Map<String, Object> s = new LinkedHashMap<>();
			s.put("maxThrust", r.getMaxThrustInNewton());
			s.put("totalImpulse", r.getTotalImpulseInNewtonSecond());
			s.put("isp", r.getSpecificImpulseInSecond());
			s.put("maxPressure", r.getMaxChamberPressureInMPa());
			s.put("averagePressure", r.getAverageChamberPressureInMPa());
			s.put("thrustTime", r.getThrustTimeInSecond());
			s.put("grainMass", r.getGrainMassInKg());
			s.put("motorClass", r.getMotorClassification().name());
			s.put("lowKnCorrections", (double) r.getNumberOfKNCorrection());
			s.put("portToThroat", r.getPortToThroatArea());
			s.put("portToThroatWarning", r.getPortToThroatAreaWarning().name());
			s.put("burnLines", (double) config.getNumberLineDuringBurnCalculation());
			out.put("summary", s);
			Nozzle n = r.getNozzle();
			Map<String, Object> nozzle = new LinkedHashMap<>();
			nozzle.put("throat", n.getNozzleThroatDiameterInMillimeter());
			nozzle.put("chamberDiameter", n.getChamberInsideDiameterInMillimeter());
			nozzle.put("expansion", n.getNozzleExpansionRatio());
			nozzle.put("exitDiameter", n.getNozzleExitDiameterInMillimeter());
			nozzle.put("optimalExpansion", n.getOptimalNozzleExpansionRatio());
			nozzle.put("optimalExitDiameter", n.getOptimalNozzleExitDiameterInMillimeter());
			nozzle.put("machInitial", n.getInitialNozzleExitSpeedInMach());
			nozzle.put("machFinal", n.getFinalNozzleExitSpeedInMach());
			out.put("nozzle", nozzle);
			List<Object> t = new ArrayList<>(), thrust = new ArrayList<>(), kn = new ArrayList<>(),
					pressure = new ArrayList<>(), flow = new ArrayList<>(), mass = new ArrayList<>();
			for (MotorParameters p : r.getMotorParameters()) {
				t.add(p.getTimeSinceBurnStartInSecond());
				thrust.add(p.getThrustInNewton());
				kn.add(p.getKn());
				pressure.add(p.getChamberPressureInMPa());
				flow.add(p.getMassFlowRateInKgPerSec());
				mass.add(p.getGrainMassInKg());
			}
			Map<String, Object> lines = new LinkedHashMap<>();
			lines.put("t", t);
			lines.put("thrust", thrust);
			lines.put("kn", kn);
			lines.put("pressure", pressure);
			lines.put("massFlow", flow);
			lines.put("grainMass", mass);
			out.put("lines", lines);
			return Json.stringify(out);
		} catch (Throwable e) {
			return error(e);
		}
	}

	/**
	 * The grain alone, for the Kn table and the throat from a target pressure: its burning area,
	 * end surface and volume at each of SRM's 50 steps of web regression (0 to the whole web).
	 * With the chamber ({ grain, chamber }), JSRM's checks of the design come first, as in
	 * simulate: a grain that cannot be (a core wider than the grain, say) is said to be, rather
	 * than measured as nothing. Those checks do not involve the throat, not yet known here.
	 */
	static String areas(Map<String, Object> m) {
		try {
			GrainConfigutation g = grain(map(m.get("grain")));
			if (m.get("chamber") != null) {
				Map<String, Object> chamber = map(m.get("chamber"));
				g.checkConfiguration(new SolidRocketMotor(new PropellantGrain(PropellantType.KNDX, g),
						new CombustionChamber(num(chamber, "diameter"), num(chamber, "length")), 0.0));
			}
			List<Object> burning = new ArrayList<>(), ends = new ArrayList<>(), volume = new ArrayList<>();
			for (int i = 0; i <= AREA_STEPS; i++) {
				double p = (double) i / AREA_STEPS;
				burning.add(g.getBurningArea(p));
				ends.add(g.getGrainEndSurface(p));
				volume.add(g.getGrainVolume(p));
			}
			Map<String, Object> out = new LinkedHashMap<>();
			out.put("burningArea", burning);
			out.put("endSurface", ends);
			out.put("volume", volume);
			return Json.stringify(out);
		} catch (Throwable e) {
			return error(e);
		}
	}

	private static SolidRocketMotor motor(Map<String, Object> m) {
		Map<String, Object> chamber = map(m.get("chamber"));
		PropellantGrain grain = new PropellantGrain(propellant(String.valueOf(m.get("propellant"))), grain(map(m.get("grain"))));
		return new SolidRocketMotor(grain, new CombustionChamber(num(chamber, "diameter"), num(chamber, "length")), num(m, "throat"));
	}

	/** SRM_2023's propellants, by the names its Data and Kn worksheet lists. */
	private static PropellantType propellant(String name) {
		switch (name) {
		case "KNDX":
			return PropellantType.KNDX;
		case "KNSB fine":
			return PropellantType.KNSB_FINE;
		case "KNSB coarse":
			return PropellantType.KNSB_COARSE;
		case "KNSU":
			return PropellantType.KNSU;
		case "KNER coarse":
			return PropellantType.KNER_COARSE;
		case "KNMN coarse":
			return PropellantType.KNMN_COARSE;
		case "KNPSB":
			return PropellantType.KNPSB;
		case "KNFR":
			return PropellantType.KNFR;
		default:
			throw new IllegalArgumentException("Unknown propellant.");
		}
	}

	/**
	 * Grains already made, with what JSRM has worked out about them: a shaped grain keeps the areas
	 * of its burned-back cross-sections (scripts/jsrm-reuse-cross-section.patch), which take most of
	 * a calculation's time. A change to anything but the grain (the nozzle, the propellant, the
	 * chamber, the settings) reuses them. JSRM only reads a grain once it is made, and a grain
	 * answers each question the same way every time, so the results are those of a new grain. The
	 * last few grains are kept, for going back and forth between them.
	 */
	private static final Map<Map<String, Object>, GrainConfigutation> GRAINS = new LinkedHashMap<Map<String, Object>, GrainConfigutation>(8, 0.75f, true) {
		private static final long serialVersionUID = 1L;

		@Override
		protected boolean removeEldestEntry(Map.Entry<Map<String, Object>, GrainConfigutation> eldest) {
			return size() > 4;
		}
	};

	private static GrainConfigutation grain(Map<String, Object> g) {
		GrainConfigutation made = GRAINS.get(g);
		if (made == null) {
			made = newGrain(g);
			GRAINS.put(new LinkedHashMap<>(g), made);
		}
		return made;
	}

	private static GrainConfigutation newGrain(Map<String, Object> g) {
		switch (String.valueOf(g.get("type"))) {
		case "hollow":
			return new HollowCylinderGrain(num(g, "outerDiameter"), num(g, "coreDiameter"), num(g, "segmentLength"), count(g, "segments"),
					surface(g, "outer"), surface(g, "ends"), surface(g, "core"));
		case "rodTube":
			return new RodAndTubeGrain(num(g, "rodDiameter"), num(g, "tubeOuterDiameter"), num(g, "tubeInnerDiameter"), count(g, "segments"),
					num(g, "segmentLength"), surface(g, "ends"));
		case "endBurner":
			return new EndBurnerGrain(num(g, "length"), num(g, "outerDiameter"), num(g, "holeDiameter"), num(g, "holeDepth"));
		case "cSlot":
			return new CSlotGrain(num(g, "outerDiameter"), num(g, "coreDiameter"), num(g, "slotWidth"), num(g, "slotDepth"), num(g, "slotOffset"),
					count(g, "segments"), num(g, "segmentLength"), surface(g, "ends"));
		case "finocyl":
			return new FinocylGrain(num(g, "outerDiameter"), num(g, "innerDiameter"), num(g, "finWidth"), num(g, "finDiameter"), count(g, "finCount"),
					num(g, "segmentLength"), count(g, "segments"), surface(g, "ends"));
		case "moonBurner":
			return new MoonBurnerGrain(num(g, "outerDiameter"), num(g, "coreDiameter"), num(g, "coreOffset"), count(g, "segments"),
					num(g, "segmentLength"), surface(g, "ends"));
		case "star":
			return new StarGrain(num(g, "outerDiameter"), num(g, "innerDiameter"), num(g, "pointDiameter"), count(g, "pointCount"),
					count(g, "segments"), num(g, "segmentLength"), surface(g, "ends"));
		default:
			throw new IllegalArgumentException("Unknown grain.");
		}
	}

	/** SRM's settings (JSRM's defaults are SRM's): any left out keep their default. */
	private static JSRMConfig config(Map<String, Object> s) {
		JSRMConfigBuilder b = new JSRMConfigBuilder();
		if (s.get("densityRatio") != null) {
			b.withDensityRatio(num(s, "densityRatio"));
		}
		if (s.get("nozzleErosion") != null) {
			b.withNozzleErosionInMillimeter(num(s, "nozzleErosion"));
		}
		if (s.get("combustionEfficiency") != null) {
			b.withCombustionEfficiencyRatio(num(s, "combustionEfficiency"));
		}
		if (s.get("ambientPressure") != null) {
			b.withAmbiantPressureInMPa(num(s, "ambientPressure"));
		}
		if (s.get("erosiveThreshold") != null) {
			b.withErosiveBurningAreaRatioThreshold(num(s, "erosiveThreshold"));
		}
		if (s.get("erosiveCoefficient") != null) {
			b.withErosiveBurningVelocityCoefficient(num(s, "erosiveCoefficient"));
		}
		if (s.get("nozzleEfficiency") != null) {
			b.withNozzleEfficiency(num(s, "nozzleEfficiency"));
		}
		// A given expansion ratio (SRM's Ae/At), or METEOR's optimal nozzle for the motor.
		if (s.get("expansionRatio") != null) {
			b.withNozzleExpansionRatio(num(s, "expansionRatio"));
		} else {
			b.withOptimalNozzleDesign(true);
		}
		return b.createJSRMConfig();
	}

	/** What went wrong, for the page: { error, kind }. */
	private static String error(Throwable e) {
		Throwable cause = e;
		while (cause.getCause() != null && cause.getCause() != cause) {
			if (cause instanceof InvalidMotorDesignException || cause instanceof ChamberPressureOutOfBoundException
					|| cause instanceof MotorClassificationOutOfBoundException) {
				break;
			}
			cause = cause.getCause();
		}
		String kind;
		if (cause instanceof InvalidMotorDesignException) {
			kind = "design";
		} else if (cause instanceof ChamberPressureOutOfBoundException) {
			kind = "pressure";
		} else if (cause instanceof MotorClassificationOutOfBoundException) {
			kind = "class";
		} else if (cause instanceof IllegalArgumentException || cause instanceof ClassCastException
				|| cause instanceof NullPointerException) {
			kind = "input";
		} else {
			kind = "failed";
		}
		Map<String, Object> out = new LinkedHashMap<>();
		out.put("error", cause.getMessage() == null ? "" : cause.getMessage());
		out.put("kind", kind);
		return Json.stringify(out);
	}

	@SuppressWarnings("unchecked")
	private static Map<String, Object> map(Object o) {
		if (!(o instanceof Map)) {
			throw new IllegalArgumentException("Missing part of the motor.");
		}
		return (Map<String, Object>) o;
	}

	private static double num(Map<String, Object> m, String key) {
		Object v = m.get(key);
		if (!(v instanceof Number) || Double.isNaN(((Number) v).doubleValue()) || Double.isInfinite(((Number) v).doubleValue())) {
			throw new IllegalArgumentException("Missing " + key + ".");
		}
		return ((Number) v).doubleValue();
	}

	private static int count(Map<String, Object> m, String key) {
		double v = num(m, key);
		if (v != Math.rint(v) || v < 0 || v > 1000) {
			throw new IllegalArgumentException("Not a whole number: " + key + ".");
		}
		return (int) v;
	}

	private static GrainSurface surface(Map<String, Object> m, String key) {
		return "inhibited".equals(m.get(key)) ? GrainSurface.INHIBITED : GrainSurface.EXPOSED;
	}
}
