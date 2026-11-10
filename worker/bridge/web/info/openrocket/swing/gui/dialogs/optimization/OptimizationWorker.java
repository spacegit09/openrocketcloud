package info.openrocket.swing.gui.dialogs.optimization;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.LinkedBlockingQueue;

import javax.swing.SwingUtilities;

import info.openrocket.core.document.Simulation;
import info.openrocket.core.optimization.general.OptimizationException;
import info.openrocket.core.optimization.general.Point;
import info.openrocket.core.optimization.rocketoptimization.OptimizableParameter;
import info.openrocket.core.optimization.rocketoptimization.OptimizationGoal;
import info.openrocket.core.optimization.rocketoptimization.SimulationModifier;
import info.openrocket.core.unit.Value;
import info.openrocket.core.util.BugException;
import orcloud.optimization.ConstrainedSearch;
import orcloud.optimization.RocketObjective;

/**
 * Rocket in Cloud's copy of OpenRocket's optimisation worker: it runs our search
 * (ConstrainedSearch on RocketObjective: each design in the simulation's own gusts, limits followed
 * rather than stopped at, the flutter limit) in place of OpenRocket's multidirectional search and
 * golden section search, and tells the dialog as OpenRocket's did. Its simulations pause for a
 * moment now and then, so that the browser's window stays responsive.
 */
public abstract class OptimizationWorker extends Thread {
	private static final long PURGE_TIMEOUT = 500;
	/** What a design past the limits counts as (as OpenRocket's function had it). */
	private static final double OUTSIDE_DOMAIN_SCALE = 1.0e200;

	private final RocketObjective objective;
	private final OptimizableParameter parameter;
	private final SimulationModifier[] modifiers;

	private final LinkedBlockingQueue<FunctionEvaluationData> evaluationQueue = new LinkedBlockingQueue<>();
	private final LinkedBlockingQueue<OptimizationStepData> stepQueue = new LinkedBlockingQueue<>();
	private volatile long lastPurge = 0;
	private OptimizationException optimizationException = null;
	/** The best design found (set when the search ends). */
	private volatile RocketObjective.Outcome outcome;

	/** Made on the Swing thread: it copies what it needs of the simulation. */
	public OptimizationWorker(Simulation simulation, OptimizableParameter parameter, OptimizationGoal goal, RocketObjective.Limits limits,
			SimulationModifier... modifiers) {
		this.parameter = parameter;
		this.modifiers = modifiers.clone();
		long[] slice = { System.currentTimeMillis() };
		this.objective = new RocketObjective(simulation, parameter, goal, limits, modifiers, () -> {
			// Under CheerpJ all Java threads share the browser's one thread, and a busy one is not
			// interrupted: 1 ms of sleep every 30 ms keeps the window responding.
			if (System.currentTimeMillis() - slice[0] > 30) {
				try {
					Thread.sleep(1);
				} catch (InterruptedException e) {
					Thread.currentThread().interrupt();
				}
				slice[0] = System.currentTimeMillis();
			}
		});
	}

	public RocketObjective.Outcome getOutcome() {
		return outcome;
	}

	@Override
	public void run() {
		try {
			outcome = objective.optimize(new ConstrainedSearch.Settings(), new RocketObjective.Listener() {
				@Override
				public void evaluated(RocketObjective.Evaluation e) {
					publish(data(e), null);
				}

				@Override
				public void stepped(RocketObjective.Evaluation from, RocketObjective.Evaluation to, double step) {
					publish(null, new OptimizationStepData(new Point(from.scaled), goalValue(from), new Point(to.scaled), goalValue(to), step));
				}
			});
		} catch (OptimizationException e) {
			this.optimizationException = e;
		} catch (InterruptedException e) {
			// Stopped.
		} finally {
			SwingUtilities.invokeLater(() -> {
				lastPurge = System.currentTimeMillis() + 24L * 3600L * 1000L;
				RocketObjective.Outcome o = outcome;
				if (o != null && o.best != null) {
					// The last step lands on the best design, whatever the search did after it.
					stepQueue.add(new OptimizationStepData(new Point(o.best.scaled), goalValue(o.best), new Point(o.best.scaled),
							goalValue(o.best), 0));
				}
				processQueue();
				done(optimizationException);
			});
		}
	}

	/** The dialog's record of an evaluation. */
	private FunctionEvaluationData data(RocketObjective.Evaluation e) {
		Value[] state = new Value[modifiers.length];
		for (int i = 0; i < modifiers.length; i++) {
			state[i] = new Value(e.values[i], modifiers[i].getUnitGroup().getDefaultUnit());
		}
		Value parameterValue = e.simulated() ? new Value(e.parameter, parameter.getUnitGroup().getDefaultUnit()) : null;
		return new Evaluated(new Point(e.scaled), state, objective.stabilityValue(e), parameterValue, goalValue(e), e);
	}

	/** What the dialog's plot and saved path take as the goal function's value. */
	private static double goalValue(RocketObjective.Evaluation e) {
		if (e.score.feasible()) {
			return e.goal;
		}
		return Double.isInfinite(e.score.violation) || Double.isNaN(e.score.violation) ? Double.MAX_VALUE
				: (e.score.violation + 1) * OUTSIDE_DOMAIN_SCALE;
	}

	/** An evaluation with the design's flutter margin and stability alongside. */
	public static final class Evaluated extends FunctionEvaluationData {
		public final RocketObjective.Evaluation evaluation;

		Evaluated(Point point, Value[] state, Value domainReference, Value parameterValue, double goalValue, RocketObjective.Evaluation e) {
			super(point, state, domainReference, parameterValue, goalValue);
			this.evaluation = e;
		}
	}

	protected abstract void done(OptimizationException exception);

	protected abstract void functionEvaluated(List<FunctionEvaluationData> data);

	protected abstract void optimizationStepTaken(List<OptimizationStepData> data);

	private synchronized void publish(FunctionEvaluationData evaluation, OptimizationStepData step) {
		if (evaluation != null) {
			evaluationQueue.add(evaluation);
		}
		if (step != null) {
			stepQueue.add(step);
		}
		long now = System.currentTimeMillis();
		if (lastPurge + PURGE_TIMEOUT <= now) {
			lastPurge = now;
			SwingUtilities.invokeLater(this::processQueue);
		}
	}

	private void processQueue() {
		if (!SwingUtilities.isEventDispatchThread()) {
			throw new BugException("processQueue called from non-EDT");
		}
		List<FunctionEvaluationData> evaluations = new ArrayList<>();
		evaluationQueue.drainTo(evaluations);
		if (!evaluations.isEmpty()) {
			functionEvaluated(evaluations);
		}
		List<OptimizationStepData> steps = new ArrayList<>();
		stepQueue.drainTo(steps);
		if (!steps.isEmpty()) {
			optimizationStepTaken(steps);
		}
	}
}
