// Route planning over the station/path graph (Traffic & Resources box).

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export class RouteGraph {
  constructor(site) {
    this.site = site;
    this.stations = new Map(site.stations.map((s) => [s.id, s]));
    this.adjacency = new Map(site.stations.map((s) => [s.id, []]));
    for (const [a, b] of site.paths) {
      const cost = dist(this.stations.get(a), this.stations.get(b));
      this.adjacency.get(a).push({ to: b, cost });
      this.adjacency.get(b).push({ to: a, cost });
    }
  }

  station(id) {
    return this.stations.get(id);
  }

  nearestStation(pose) {
    let best = null;
    for (const s of this.stations.values()) {
      if (!best || dist(s, pose) < dist(best, pose)) best = s;
    }
    return best;
  }

  /** Dijkstra between two station ids. Returns { stations: [ids], length } or null. */
  shortestPath(fromId, toId) {
    const cost = new Map([[fromId, 0]]);
    const prev = new Map();
    const open = new Set([fromId]);
    while (open.size) {
      let current = null;
      for (const id of open) if (current === null || cost.get(id) < cost.get(current)) current = id;
      if (current === toId) break;
      open.delete(current);
      for (const edge of this.adjacency.get(current)) {
        const next = cost.get(current) + edge.cost;
        if (next < (cost.get(edge.to) ?? Infinity)) {
          cost.set(edge.to, next);
          prev.set(edge.to, current);
          open.add(edge.to);
        }
      }
    }
    if (!cost.has(toId)) return null;
    const stations = [toId];
    while (stations[0] !== fromId) stations.unshift(prev.get(stations[0]));
    return { stations, length: cost.get(toId) };
  }

  /**
   * Route from an arbitrary pose to a station: join the graph at the nearest
   * station, then follow the shortest path.
   * Returns { waypoints: [{x, y}], length } or null when unreachable.
   */
  route(pose, toId) {
    const entry = this.nearestStation(pose);
    const path = this.shortestPath(entry.id, toId);
    if (!path) return null;
    const waypoints = path.stations.map((id) => {
      const s = this.stations.get(id);
      return { x: s.x, y: s.y };
    });
    const lead = dist(pose, entry);
    // Already standing on the entry station: no need to drive to it first.
    if (lead < 0.15 && waypoints.length > 1) waypoints.shift();
    return { waypoints, length: lead + path.length };
  }
}
