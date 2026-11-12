import { safeExtractFirstXmlElement } from './xml-helpers';

/**
 * 2D Affine Transformation Matrix (3x3 homogeneous coordinates)
 * Represents [a, b, c, d, e, f] where:
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 */
export type Matrix2D = [number, number, number, number, number, number];

export function identityMatrix(): Matrix2D {
  return [1, 0, 0, 1, 0, 0];
}

export function multiplyMatrix(m1: Matrix2D, m2: Matrix2D): Matrix2D {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function translationMatrix(tx: number, ty: number): Matrix2D {
  return [1, 0, 0, 1, tx, ty];
}

export function scaleMatrix(sx: number, sy: number): Matrix2D {
  return [sx, 0, 0, sy, 0, 0];
}

export function rotationMatrix(deg: number): Matrix2D {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [cos, sin, -sin, cos, 0, 0];
}

export function transformPoint(m: Matrix2D, x: number, y: number): { x: number; y: number } {
  return {
    x: m[0] * x + m[2] * y + m[4],
    y: m[1] * x + m[3] * y + m[5],
  };
}

/**
 * Computes the DrawingML group affine transformation matrix (ISO/IEC 29500-1 CT_GroupTransform2D)
 * mapping child coordinate space (chOff, chExt) into the group's bounding box (off, ext),
 * accounting for group rotation (around parent center) and flipH / flipV.
 */
export function computeGroupTransformMatrix(
  off: { x: number; y: number },
  ext: { cx: number; cy: number },
  chOff: { x: number; y: number },
  chExt: { cx: number; cy: number },
  rot: number = 0, // in degrees clockwise
  flipH: boolean = false,
  flipV: boolean = false
): Matrix2D {
  const chw = chExt.cx !== 0 ? chExt.cx : (ext.cx !== 0 ? ext.cx : 1);
  const chh = chExt.cy !== 0 ? chExt.cy : (ext.cy !== 0 ? ext.cy : 1);
  const gw = ext.cx;
  const gh = ext.cy;

  // Center of child coordinate system
  const cChX = chOff.x + chw / 2;
  const cChY = chOff.y + chh / 2;

  // Center of parent bounding box
  const cParentX = off.x + gw / 2;
  const cParentY = off.y + gh / 2;

  // Scaling with reflection
  const sx = (gw / chw) * (flipH ? -1 : 1);
  const sy = (gh / chh) * (flipV ? -1 : 1);

  // Rotation in radians
  const rad = (rot * Math.PI) / 180;

  // M = T(cParentX, cParentY) * R(rad) * S(sx, sy) * T(-cChX, -cChY)
  const tOrigin = translationMatrix(-cChX, -cChY);
  const sScale = scaleMatrix(sx, sy);
  const rRot = rotationMatrix(rad);
  const tCenter = translationMatrix(cParentX, cParentY);

  return multiplyMatrix(tCenter, multiplyMatrix(rRot, multiplyMatrix(sScale, tOrigin)));
}

export interface GroupTransformResult {
  matrix: Matrix2D;
  gx: number;
  gy: number;
  gw: number;
  gh: number;
  chx: number;
  chy: number;
  chw: number;
  chh: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

/**
 * Extracts group shape transform (a:xfrm) attributes and computes the transformation matrix.
 */
export function parseGroupTransform(
  grpXml: string,
  defaultWidth = 100,
  defaultHeight = 60
): GroupTransformResult {
  const grpSpPr = safeExtractFirstXmlElement(grpXml, ['p:grpSpPr', 'wpg:grpSpPr']);
  const xfrm = safeExtractFirstXmlElement(grpSpPr?.content || grpXml, 'a:xfrm');

  let gx = 0;
  let gy = 0;
  let gw = defaultWidth;
  let gh = defaultHeight;
  let chx = 0;
  let chy = 0;
  let chw = defaultWidth;
  let chh = defaultHeight;
  let rot = 0;
  let flipH = false;
  let flipV = false;

  if (xfrm) {
    if (xfrm.attrs.rot) rot = Number.parseInt(xfrm.attrs.rot, 10) / 60000;
    if (xfrm.attrs.flipH === '1' || xfrm.attrs.flipH === 'true') flipH = true;
    if (xfrm.attrs.flipV === '1' || xfrm.attrs.flipV === 'true') flipV = true;

    const offEl = safeExtractFirstXmlElement(xfrm.content, 'a:off');
    if (offEl?.attrs.x && offEl?.attrs.y) {
      gx = Math.round(Number.parseInt(offEl.attrs.x, 10) / 12700);
      gy = Math.round(Number.parseInt(offEl.attrs.y, 10) / 12700);
    }
    const extEl = safeExtractFirstXmlElement(xfrm.content, 'a:ext');
    if (extEl?.attrs.cx && extEl?.attrs.cy) {
      gw = Math.max(1, Math.round(Number.parseInt(extEl.attrs.cx, 10) / 12700));
      gh = Math.max(1, Math.round(Number.parseInt(extEl.attrs.cy, 10) / 12700));
    }
    const chOffEl = safeExtractFirstXmlElement(xfrm.content, 'a:chOff');
    if (chOffEl?.attrs.x && chOffEl?.attrs.y) {
      chx = Math.round(Number.parseInt(chOffEl.attrs.x, 10) / 12700);
      chy = Math.round(Number.parseInt(chOffEl.attrs.y, 10) / 12700);
    } else {
      chx = gx;
      chy = gy;
    }
    const chExtEl = safeExtractFirstXmlElement(xfrm.content, 'a:chExt');
    if (chExtEl?.attrs.cx && chExtEl?.attrs.cy) {
      chw = Math.max(1, Math.round(Number.parseInt(chExtEl.attrs.cx, 10) / 12700));
      chh = Math.max(1, Math.round(Number.parseInt(chExtEl.attrs.cy, 10) / 12700));
    } else {
      chw = gw;
      chh = gh;
    }
  }

  const matrix = computeGroupTransformMatrix(
    { x: gx, y: gy },
    { cx: gw, cy: gh },
    { x: chx, y: chy },
    { cx: chw, cy: chh },
    rot,
    flipH,
    flipV
  );

  return { matrix, gx, gy, gw, gh, chx, chy, chw, chh, rot, flipH, flipV };
}

export interface TransformedElementBounds {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
  matrix: Matrix2D;
}

/**
 * Computes world coordinates and bounds for a standalone shape or picture element.
 */
export function computeTransformedElementBounds(
  xml: string,
  parentMatrix: Matrix2D
): TransformedElementBounds | null {
  const offEl = safeExtractFirstXmlElement(xml, 'a:off');
  const extEl = safeExtractFirstXmlElement(xml, 'a:ext');
  if (!offEl?.attrs.x || !offEl?.attrs.y || !extEl?.attrs.cx || !extEl?.attrs.cy) {
    return null;
  }

  const rawX = Math.round(Number.parseInt(offEl.attrs.x, 10) / 12700);
  const rawY = Math.round(Number.parseInt(offEl.attrs.y, 10) / 12700);
  const rawW = Math.max(1, Math.round(Number.parseInt(extEl.attrs.cx, 10) / 12700));
  const rawH = Math.max(1, Math.round(Number.parseInt(extEl.attrs.cy, 10) / 12700));

  const xfrmEl = safeExtractFirstXmlElement(xml, 'a:xfrm');
  let rot = 0;
  let flipH = false;
  let flipV = false;
  if (xfrmEl) {
    if (xfrmEl.attrs.rot) rot = Number.parseInt(xfrmEl.attrs.rot, 10) / 60000;
    if (xfrmEl.attrs.flipH === '1' || xfrmEl.attrs.flipH === 'true') flipH = true;
    if (xfrmEl.attrs.flipV === '1' || xfrmEl.attrs.flipV === 'true') flipV = true;
  }

  const localMatrix = computeGroupTransformMatrix(
    { x: rawX, y: rawY },
    { cx: rawW, cy: rawH },
    { x: rawX, y: rawY },
    { cx: rawW, cy: rawH },
    rot,
    flipH,
    flipV
  );
  const worldMatrix = multiplyMatrix(parentMatrix, localMatrix);

  const centerWorld = transformPoint(worldMatrix, rawX + rawW / 2, rawY + rawH / 2);
  const worldW = Math.max(1, Math.round(Math.hypot(worldMatrix[0], worldMatrix[1]) * rawW));
  const worldH = Math.max(1, Math.round(Math.hypot(worldMatrix[2], worldMatrix[3]) * rawH));
  const worldRot = Math.round((Math.atan2(worldMatrix[1], worldMatrix[0]) * 180) / Math.PI);
  const x = Math.round(centerWorld.x - worldW / 2);
  const y = Math.round(centerWorld.y - worldH / 2);

  return { x, y, w: worldW, h: worldH, rot: worldRot, flipH, flipV, matrix: worldMatrix };
}
