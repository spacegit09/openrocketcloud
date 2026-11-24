// The page's side of the motor designer's calculator (orcloud.bridge.MotorMain): requests queue
// here until Java asks for the next one, and Java's replies settle them (as flight/lab-natives.js
// does for the launch planner's OpenRocket).
const queue = [];
const pending = new Map();
let waiting = null;
let nextId = 0;

/** Sends a request ({ op, motor }) to the calculator and resolves to its reply (JSON text). */
export function motorRequest(msg) {
  const id = ++nextId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    const text = JSON.stringify({ id, ...msg });
    if (waiting) {
      const w = waiting;
      waiting = null;
      w(text);
    } else {
      queue.push(text);
    }
  });
}

export const motorNatives = {
  async Java_orcloud_bridge_MotorMain_jsNext() {
    return queue.length ? queue.shift() : new Promise((resolve) => (waiting = resolve));
  },
  async Java_orcloud_bridge_MotorMain_jsReply(lib, id, json) {
    pending.get(id)?.(json);
    pending.delete(id);
  },
};
