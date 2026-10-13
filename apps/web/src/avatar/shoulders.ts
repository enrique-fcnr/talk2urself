import * as THREE from 'three';

type RimVertex = { position: THREE.Vector3; normal: THREE.Vector3 };

// Weld only for finding Kelly's open neck rim. Facial geometry is untouched.
function neckRim(head: THREE.BufferGeometry): RimVertex[] {
  const positions = head.attributes.position, normals = head.attributes.normal;
  const vertices = new Map<string, RimVertex>();
  const edges = new Map<string, { a: string; b: string; count: number }>();
  const keyAt = (i: number) => [positions.getX(i), positions.getY(i), positions.getZ(i)].map(v => v.toFixed(6)).join(',');
  const count = head.index?.count ?? positions.count;
  for (let triangle = 0; triangle < count; triangle += 3) {
    const ids = [0, 1, 2].map(offset => head.index?.getX(triangle + offset) ?? triangle + offset);
    for (const i of ids) {
      if (positions.getY(i) >= -.085) continue;
      const key = keyAt(i);
      if (!vertices.has(key)) vertices.set(key, { position: new THREE.Vector3().fromBufferAttribute(positions, i), normal: new THREE.Vector3() });
      vertices.get(key)!.normal.add(new THREE.Vector3().fromBufferAttribute(normals, i));
    }
    for (let edge = 0; edge < 3; edge++) {
      const a = ids[edge], b = ids[(edge + 1) % 3];
      if (positions.getY(a) >= -.085 || positions.getY(b) >= -.085) continue;
      const ka = keyAt(a), kb = keyAt(b), key = [ka, kb].sort().join('|');
      const entry = edges.get(key) ?? { a: ka, b: kb, count: 0 };
      entry.count++; edges.set(key, entry);
    }
  }
  const boundary = new Set<string>();
  for (const edge of edges.values()) if (edge.count === 1) { boundary.add(edge.a); boundary.add(edge.b); }
  const rim = [...boundary].map(key => vertices.get(key)!);
  if (rim.length < 3) throw new Error('Kelly neck rim unavailable');
  const center = new THREE.Box3().setFromPoints(rim.map(v => v.position)).getCenter(new THREE.Vector3());
  rim.sort((a, b) => Math.atan2(a.position.x - center.x, a.position.z - center.z) - Math.atan2(b.position.x - center.x, b.position.z - center.z));
  for (const vertex of rim) vertex.normal.normalize();
  return rim;
}

export function createShouldersGeometry(head: THREE.BufferGeometry) {
  const rim = neckRim(head), columns = rim.length, neckRows = 24, bodyRows = 28, rows = neckRows + bodyRows;
  const center = new THREE.Box3().setFromPoints(rim.map(v => v.position)).getCenter(new THREE.Vector3());
  const body = new THREE.CatmullRomCurve3([
    new THREE.Vector3(.159, -.177, .074), new THREE.Vector3(.199, -.211, .082),
    new THREE.Vector3(.202, -.247, .081), new THREE.Vector3(.180, -.290, .072)
  ], false, 'centripetal');
  const positions: number[] = [], indices: number[] = [];
  const surfacePoint = (profile: THREE.Vector3, angle: number) => new THREE.Vector3(Math.sin(angle) * profile.x, profile.y, Math.cos(angle) * profile.z - .002);
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
    const vertex = rim[col % columns], start = vertex.position, n = vertex.normal;
    const angle = Math.atan2(start.x - center.x, start.z - center.z);
    let p: THREE.Vector3;
    if (row <= neckRows) {
      const t = row / neckRows, end = surfacePoint(body.getPoint(0), angle), drop = start.y - end.y;
      // Continue the rim's skin tangent, then meet the shoulder surface.
      const denominator = Math.max(.1, 1 - n.y * n.y);
      const tangentStart = new THREE.Vector3(n.x * n.y / denominator, -1, n.z * n.y / denominator).multiplyScalar(drop);
      const tangentEnd = surfacePoint(body.getPoint(.001), angle).sub(end);
      tangentEnd.multiplyScalar(drop / -tangentEnd.y);
      p = start.clone().multiplyScalar(2 * t ** 3 - 3 * t ** 2 + 1)
        .addScaledVector(tangentStart, t ** 3 - 2 * t ** 2 + t)
        .addScaledVector(end, -2 * t ** 3 + 3 * t ** 2)
        .addScaledVector(tangentEnd, t ** 3 - t ** 2);
    } else p = surfacePoint(body.getPoint((row - neckRows) / bodyRows), angle);
    positions.push(p.x, p.y, p.z);
  }
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    const a = row * (columns + 1) + col, b = a + columns + 1;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const base = positions.length / 3; positions.push(0, -.290, -.002);
  for (let col = 0; col < columns; col++) indices.push(base, rows * (columns + 1) + col + 1, rows * (columns + 1) + col);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals();
  const normals = geometry.attributes.normal;
  for (let row = 0; row <= rows; row++) {
    const first = row * (columns + 1), last = first + columns;
    const n = new THREE.Vector3().fromBufferAttribute(normals, first).add(new THREE.Vector3().fromBufferAttribute(normals, last)).normalize();
    normals.setXYZ(first, n.x, n.y, n.z); normals.setXYZ(last, n.x, n.y, n.z);
  }
  for (let col = 0; col <= columns; col++) {
    const n = rim[col % columns].normal;
    normals.setXYZ(col, n.x, n.y, n.z);
  }
  return geometry;
}
