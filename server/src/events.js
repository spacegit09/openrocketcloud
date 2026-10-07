// Server-sent events to browsers: presence, activity and session state for one project.

const subscribers = new Map(); // projectId -> Set<{ res, userId }>

export function subscribe(projectId, userId, req, res, initial = []) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const sub = { res, userId };
  if (!subscribers.has(projectId)) subscribers.set(projectId, new Set());
  subscribers.get(projectId).add(sub);
  for (const event of initial) send(sub, event);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    subscribers.get(projectId)?.delete(sub);
    if (!subscribers.get(projectId)?.size) subscribers.delete(projectId);
  });
}

function send(sub, event) {
  sub.res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** Sends to everyone watching the project, or only to one user when `toUser` is given. */
export function publish(projectId, event, toUser = null) {
  for (const sub of subscribers.get(projectId) ?? []) {
    if (!toUser || sub.userId === toUser) send(sub, event);
  }
}

export function watcherCount(projectId) {
  return subscribers.get(projectId)?.size ?? 0;
}
