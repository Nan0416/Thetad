/**
 * Sequential color ramps for heatmap fills: piecewise-linear interpolation
 * between hex stops in OKLab, so equal IV steps read as equal color steps
 * (sRGB lerp would bow through gray between chromatic stops).
 */

type Triplet = readonly [number, number, number];

function hexToRgb(hex: string): Triplet {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(linear: number): number {
  const c = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

function rgbToOklab([r, g, b]: Triplet): Triplet {
  const [lr, lg, lb] = [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([L, a, b]: Triplet): Triplet {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

export type Ramp = (t: number) => string;

/** t in [0,1] (clamped) -> hex color along the stops. */
export function makeRamp(stops: readonly string[]): Ramp {
  if (stops.length < 2) throw new RangeError('a ramp needs at least two stops');
  const labs = stops.map((stop) => rgbToOklab(hexToRgb(stop)));
  return (t: number) => {
    const clamped = Math.min(1, Math.max(0, t));
    const scaled = clamped * (labs.length - 1);
    const i = Math.min(labs.length - 2, Math.floor(scaled));
    const f = scaled - i;
    const [a, b] = [labs[i]!, labs[i + 1]!];
    const [r, g, bl] = oklabToRgb([
      a[0] + (b[0] - a[0]) * f,
      a[1] + (b[1] - a[1]) * f,
      a[2] + (b[2] - a[2]) * f,
    ]);
    return `#${((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1)}`;
  };
}

/** CSS gradient approximating the ramp, for scale legends. */
export function rampCssGradient(ramp: Ramp): string {
  const stops = [0, 0.25, 0.5, 0.75, 1].map((t) => `${ramp(t)} ${t * 100}%`).join(', ');
  return `linear-gradient(90deg, ${stops})`;
}
