// The page's side of the launch planner's OpenRocket program (orcloud.bridge.FlightMain): requests
// queue here until Java asks for the next one, and Java's replies settle them.
const queue = [];
const pending = new Map();
let waiting = null;
let nextId = 0;

/** Sends a request ({ op, ... }) to OpenRocket and resolves to its reply (JSON text). */
export function labRequest(msg) {
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

export const labNatives = {
  async Java_orcloud_bridge_FlightMain_jsNext() {
    return queue.length ? queue.shift() : new Promise((resolve) => (waiting = resolve));
  },
  async Java_orcloud_bridge_FlightMain_jsReply(lib, id, json) {
    pending.get(id)?.(json);
    pending.delete(id);
  },
};
