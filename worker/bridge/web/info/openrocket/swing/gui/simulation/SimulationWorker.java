/*
 * Copy of OpenRocket 24.12's SimulationWorker (GPL-3.0, (c) the OpenRocket team) for the browser build,
 * with one change: CancelListener lets other threads run every 30 ms. It is placed ahead of
 * OpenRocket.jar on the class path.
 */
package info.openrocket.swing.gui.simulation;

import java.util.Arrays;

import javax.swing.SwingWorker;

import info.openrocket.core.document.Simulation;
import info.openrocket.core.simulation.FlightData;
import info.openrocket.core.simulation.SimulationStatus;
import info.openrocket.core.simulation.exception.SimulationCancelledException;
import info.openrocket.core.simulation.listeners.AbstractSimulationListener;
import info.openrocket.core.simulation.listeners.SimulationListener;



/**
 * A SwingWorker that runs a simulation in a background thread.  The simulation
 * always includes a listener that checks whether this SwingWorked has been cancelled,
 * and throws a {@link SimulationCancelledException} if it has.  This allows the
 * {@link #cancel(boolean)} method to be used to cancel the simulation.
 * 
 * @author Sampo Niskanen <sampo.niskanen@iki.fi>
 */
public abstract class SimulationWorker extends SwingWorker<FlightData, SimulationStatus> {
	
	protected final Simulation simulation;
	private Throwable throwable = null;
	
	public SimulationWorker(Simulation sim) {
		this.simulation = sim;
	}
	
	
	/**
	 * Runs the simulation.
	 */
	@Override
	protected FlightData doInBackground() {
		if (isCancelled()) {
			throwable = new SimulationCancelledException("The simulation was interrupted.");
			return null;
		}
		
		SimulationListener[] listeners = getExtraListeners();
		
		if (listeners != null) {
			listeners = Arrays.copyOf(listeners, listeners.length + 1);
		} else {
			listeners = new SimulationListener[1];
		}
		
		listeners[listeners.length - 1] = new CancelListener();
		
		try {
			simulation.simulate(listeners);
		} catch (Throwable e) {
			throwable = e;
			return null;
		}
		return simulation.getSimulatedData();
	}
	
	
	/**
	 * Return additional listeners to use during the simulation.  The default
	 * implementation returns an empty array.
	 * 
	 * @return	additional listeners to use, or <code>null</code>.
	 */
	protected SimulationListener[] getExtraListeners() {
		return new SimulationListener[0];
	}

	/**
	 * Returns the throwable that caused the simulation to fail or cancel,
	 * or null if the simulation ran successfully.
	 *
	 * @return throwable that caused the simulation to fail or cancel,
	 * 		or null if the simulation ran successfully.
	 */
	public Throwable getThrowable() {
		return throwable;
	}
	
	
	/**
	 * Called after a simulation is successfully simulated.  This method is not
	 * called if the simulation ends in an exception.
	 */
	protected abstract void simulationDone();
	
	/**
	 * Called if the simulation is interrupted due to an exception.
	 * 
	 * @param t		the Throwable that caused the interruption
	 */
	protected abstract void simulationInterrupted(Throwable t);
	
	
	
	/**
	 * Marks this simulation as done and calls the progress update.
	 */
	@Override
	protected final void done() {
		if (throwable == null)
			simulationDone();
		else
			simulationInterrupted(throwable);
	}
	
	
	
	/**
	 * A simulation listener that throws a {@link SimulationCancelledException} if
	 * this SwingWorker has been cancelled.  The conditions is checked every time a step
	 * is taken.
	 * 
	 * @author Sampo Niskanen <sampo.niskanen@iki.fi>
	 */
	private class CancelListener extends AbstractSimulationListener {
		// Rocket in Cloud (browser build): under CheerpJ all Java threads share one browser thread and a busy
		// thread is not interrupted, so a running simulation would freeze the window until it ends.
		// Pausing for 1 ms every 30 ms lets the window respond; the simulation itself is unchanged.
		private long sliceStart = System.currentTimeMillis();

		@Override
		public void postStep(SimulationStatus status) throws SimulationCancelledException {
			
			if (isCancelled()) {
				throw new SimulationCancelledException("The simulation was interrupted.");
			}
			
			if (System.currentTimeMillis() - sliceStart > 30) {
				try {
					Thread.sleep(1);
				} catch (InterruptedException e) {
					throw new SimulationCancelledException("The simulation was interrupted.");
				}
				sliceStart = System.currentTimeMillis();
			}
		}
	}
}
