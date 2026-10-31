/**
 * The key of two-step verification as a QR code (D-236), for an authenticator app to read: an SVG drawn from
 * `lean-qr`'s modules, so the page holds no image and no script of the library's. Dark modules on a light
 * ground in every theme — a scanner reads that one way round — from the two colours that stay put: `on-status`
 * (near black) and `on-accent` (white). The four-module quiet zone is the standard's.
 */
import { generate } from 'lean-qr';
import { toSvgPath } from 'lean-qr/extras/svg';

/** ISO 18004's quiet zone around the symbol, in modules. */
const QUIET_ZONE = 4;

export const TwoFactorQr = ({
  value,
  label,
}: {
  readonly value: string;
  readonly label: string;
}): React.JSX.Element => {
  const code = generate(value);
  const side = code.size + QUIET_ZONE * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`${String(-QUIET_ZONE)} ${String(-QUIET_ZONE)} ${String(side)} ${String(side)}`}
      shapeRendering="crispEdges"
      className="size-qr shrink-0 rounded-md"
    >
      <rect x={-QUIET_ZONE} y={-QUIET_ZONE} width={side} height={side} className="fill-on-accent" />
      <path d={toSvgPath(code)} className="fill-on-status" />
    </svg>
  );
};
