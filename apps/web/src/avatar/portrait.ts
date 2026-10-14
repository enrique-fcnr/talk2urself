export type PortraitPoint = { x: number; y: number; z: number };

// Expand only the render surface above the logical portrait. Compensating the
// view offset preserves the subject's pixel size and bottom position.
export function portraitViewport(height: number, viewShift: number, topBleed = 0) {
  return { renderHeight: height + topBleed, offsetY: viewShift - topBleed };
}
type PortraitLayout = { width: number; height: number; headroom: number; visibleBottom: number;
  tan: number; designDistance: number; eyeLevel: number; points: readonly PortraitPoint[]; bottomAnchored?: boolean; bottomCrop?: number };

// Fit the visible scene, including decorations behind the face, below the copy.
// Points at different depths must be projected before their extents are compared.
export function portraitFrame(layout: PortraitLayout) {
  const { width, height, headroom, visibleBottom, tan, designDistance, eyeLevel, points } = layout;
  const available = Math.max(1, visibleBottom - headroom);
  const extentAt = (distance: number) => {
    const scale = height / (2 * distance * tan);
    const ys = points.map(point => (point.y - eyeLevel) * distance / (distance - point.z));
    return { scale, upper: Math.max(...ys), lower: Math.min(...ys),
      horizontal: Math.max(...points.map(point => Math.abs(point.x) * height / (2 * (distance - point.z) * tan))) };
  };
  const fits = (distance: number) => {
    const extent = extentAt(distance);
    return (extent.upper - extent.lower) * extent.scale <= available && extent.horizontal <= width / 2;
  };
  let distance = Math.max(designDistance, ...points.map(point => point.z + .01));
  if (!fits(distance)) {
    let low = distance, high = distance;
    while (!fits(high)) high *= 2;
    for (let i = 0; i < 28; i++) {
      const middle = (low + high) / 2;
      if (fits(middle)) high = middle; else low = middle;
    }
    distance = high;
  }
  const extent = extentAt(distance), clearance = eyeLevel + extent.upper;
  const top = layout.bottomAnchored ? visibleBottom + Math.max(0, layout.bottomCrop ?? 0) - (extent.upper - extent.lower) * extent.scale
    : Math.max(headroom, (.04 + distance * tan - clearance) * extent.scale);
  const viewShift = height / 2 - extent.upper * extent.scale - top;
  return { distance, viewShift };
}
